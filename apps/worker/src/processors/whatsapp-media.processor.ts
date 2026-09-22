import { createHash } from 'node:crypto';
import {
  checkMedia,
  MEDIA_POLICY,
  mediaKindOf,
  QUEUE_NAMES,
  type RealtimeEvent,
  whatsappMediaJobSchema,
} from '@nexo/contracts';
import { decrypt, runInTenantTransaction } from '@nexo/database';
import { assertTenantKey, resolveMime, SNIFF_BYTES, sniffMime, tenantKey } from '@nexo/storage';
import { type Job, UnrecoverableError } from 'bullmq';
import { env } from '../bootstrap/env';
import { downloadMedia, getMediaInfo, MediaFetchError } from '../lib/graph';
import type { Logger } from '../lib/logger';
import { defineProcessor } from '../lib/processor';
import { publishRealtime } from '../lib/realtime';
import { storage } from '../lib/storage';

/** Un rechazo definitivo: se guarda el motivo y no se reintenta. */
class Rejected extends Error {}

/** Otro intento enlazó el archivo antes que éste. */
class AlreadyLinked extends Error {}

/**
 * Descarga un archivo que envió un cliente y lo guarda en el almacenamiento de
 * su empresa.
 *
 *   1. Datos del archivo a Meta, CON el número del canal: Meta sólo entrega un
 *      archivo de ese número, así que el id de otra empresa no sirve.
 *   2. Tamaño declarado frente a la política: lo que no cabe, ni se descarga.
 *   3. Descarga sólo de dominios permitidos, sin redirecciones, con límite.
 *   4. SHA-256 igual al de Meta; tipo REAL (número mágico) coherente con el
 *      declarado y admitido por la política.
 *   5. Subida a una clave de la empresa del contexto; File READY y enlace, en
 *      una transacción y con la condición «aún sin archivo».
 *
 * Nada se sube antes de pasar las comprobaciones. Si algo falla DESPUÉS de
 * subir, el objeto se borra: no quedan huérfanos bajo el prefijo de la empresa.
 */
export const whatsappMediaProcessor = defineProcessor({
  queue: QUEUE_NAMES.WHATSAPP_MEDIA,
  schema: whatsappMediaJobSchema,
  tenantOf: (data) => data.tenantId,

  async handle(data, { job, log }) {
    // Con RLS y en la empresa del trabajo: con otra empresa, no hay fila.
    const media = await runInTenantTransaction((tx) =>
      tx.messageMedia.findUnique({
        where: { id: data.mediaId },
        select: {
          id: true,
          tenantId: true,
          fileId: true,
          downloadError: true,
          externalMediaId: true,
          filename: true,
          message: {
            select: {
              conversationId: true,
              conversation: { select: { assigneeId: true } },
              channel: {
                select: { status: true, externalId: true, credentialsEncrypted: true },
              },
            },
          },
        },
      }),
    );
    if (!media || media.tenantId !== data.tenantId) {
      throw new UnrecoverableError(`No existe el archivo ${data.mediaId} en esta empresa`);
    }
    if (media.fileId) return { skipped: 'ya descargado' };
    if (media.downloadError) return { skipped: 'ya rechazado' };

    const event: RealtimeEvent = {
      type: 'conversation',
      conversationId: media.message.conversationId,
      assigneeId: media.message.conversation.assigneeId,
      reason: 'message',
    };

    try {
      const file = await fetchAndStore(data.tenantId, media, log);
      await publishRealtime(data.tenantId, [event]);
      log.info({ mediaId: media.id, fileId: file.id, bytes: file.sizeBytes }, 'Archivo guardado');
      return { fileId: file.id };
    } catch (error) {
      if (error instanceof AlreadyLinked) return { skipped: 'otro intento lo guardó antes' };
      const definitive =
        error instanceof Rejected ||
        (error instanceof MediaFetchError && !error.retryable) ||
        isLastAttempt(job);
      if (!definitive) throw error;

      const reason = (error as Error).message;
      await markFailed(media.id, reason);
      await publishRealtime(data.tenantId, [event]);
      log.warn({ mediaId: media.id, reason }, 'Archivo de WhatsApp no guardado');
      return { failed: reason };
    }
  },
});

const isLastAttempt = (job: Job) => job.attemptsMade + 1 >= (job.opts.attempts ?? 1);

async function fetchAndStore(
  tenantId: string,
  media: {
    id: string;
    externalMediaId: string | null;
    filename: string | null;
    message: {
      channel: {
        status: string;
        externalId: string | null;
        credentialsEncrypted: string | null;
      };
    };
  },
  log: Logger,
): Promise<{ id: string; sizeBytes: number }> {
  if (!storage) throw new Rejected('El almacenamiento no está configurado');
  if (!media.externalMediaId) throw new Rejected('El mensaje no trae el id del archivo');
  const { channel } = media.message;
  if (channel.status !== 'CONNECTED' || !channel.externalId || !channel.credentialsEncrypted) {
    throw new Rejected('El canal está desconectado');
  }
  const { accessToken } = JSON.parse(decrypt(channel.credentialsEncrypted, env.ENCRYPTION_KEY)) as {
    accessToken: string;
  };

  // 1-2 · Datos de Meta y tamaño declarado.
  const info = await getMediaInfo(media.externalMediaId, channel.externalId, accessToken);
  const declaredKind = mediaKindOf(info.mimeType);
  if (!declaredKind) throw new Rejected(`Tipo de archivo no admitido: ${info.mimeType}`);
  const maxBytes = MEDIA_POLICY[declaredKind].maxBytes;
  const declared = checkMedia({ mime: info.mimeType, sizeBytes: Math.max(info.sizeBytes, 1) });
  if (!declared.ok) throw new Rejected(declared.reason);

  // 3 · Descarga protegida.
  const bytes = await downloadMedia(info.url, accessToken, maxBytes);

  // 4 · Integridad y tipo real.
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (sha256 !== info.sha256) {
    throw new Rejected('El archivo no coincide con su SHA-256: se descartó');
  }
  const real = resolveMime(info.mimeType, sniffMime(bytes.subarray(0, SNIFF_BYTES)));
  if (!real || mediaKindOf(real) !== declaredKind) {
    throw new Rejected(`El contenido no es del tipo declarado (${info.mimeType})`);
  }
  const check = checkMedia({ mime: real, sizeBytes: bytes.byteLength });
  if (!check.ok) throw new Rejected(check.reason);

  // 5 · Subida y enlace.
  const key = tenantKey(tenantId, 'whatsapp-media', check.extension);
  assertTenantKey(tenantId, key);
  await storage.put({ key, body: bytes, contentType: real, sha256 });

  try {
    return await runInTenantTransaction(async (tx) => {
      const file = await tx.file.create({
        data: {
          tenantId,
          storageKey: key,
          bucket: storage!.bucket,
          originalName: originalName(media.filename, check.kind, check.extension),
          mimeType: real,
          sizeBytes: bytes.byteLength,
          checksum: sha256,
          purpose: 'WHATSAPP_MEDIA',
          status: 'READY',
          readyAt: new Date(),
          // Sin antivirus todavía: queda dicho, no «pendiente» para siempre.
          scanStatus: 'SKIPPED',
          scanResult: 'sin antivirus configurado',
        },
        select: { id: true, sizeBytes: true },
      });
      const linked = await tx.messageMedia.updateMany({
        where: { id: media.id, fileId: null },
        data: {
          fileId: file.id,
          mimeType: real,
          sizeBytes: bytes.byteLength,
          downloadedAt: new Date(),
          downloadError: null,
        },
      });
      // Deshace también el File de esta transacción.
      if (linked.count === 0) throw new AlreadyLinked();
      return file;
    });
  } catch (error) {
    await storage
      .delete([key])
      .catch((cleanup: Error) =>
        log.error(
          { mediaId: media.id, err: cleanup.message },
          'No se pudo borrar un objeto sin enlazar; lo recogerá la limpieza',
        ),
      );
    throw error;
  }
}

async function markFailed(id: string, reason: string): Promise<void> {
  await runInTenantTransaction((tx) =>
    tx.messageMedia.updateMany({
      where: { id, fileId: null },
      data: { downloadError: reason.slice(0, 1000) },
    }),
  );
}

/** El nombre del documento tal cual; para el resto, uno descriptivo. */
function originalName(filename: string | null, kind: string, extension: string): string {
  // Sin caracteres de control ni barras: el nombre sólo se muestra y va al
  // Content-Disposition (que además lo sanea), nunca a la clave.
  const clean = [...(filename ?? '')]
    .filter((c) => {
      const code = c.charCodeAt(0);
      return code >= 0x20 && code !== 0x7f && c !== '/' && c !== '\\';
    })
    .join('')
    .trim();
  if (clean) return clean.slice(0, 255);
  const stamp = new Date().toISOString().slice(0, 10);
  return `whatsapp-${kind}-${stamp}.${extension}`;
}
