import {
  MEDIA_POLICY,
  mediaKindOf,
  QUEUE_NAMES,
  type RealtimeEvent,
  whatsappOutboundJobSchema,
} from '@nexo/contracts';
import { decrypt, runInTenantTransaction } from '@nexo/database';
import { UnrecoverableError } from 'bullmq';
import { env } from '../bootstrap/env';
import {
  GraphSendError,
  INVALID_TOKEN_CODE,
  sendWhatsappMedia,
  sendWhatsappTemplate,
  sendWhatsappText,
  uploadWhatsappMedia,
} from '../lib/graph';
import { defineProcessor } from '../lib/processor';
import { publishRealtime } from '../lib/realtime';
import { storage } from '../lib/storage';

/**
 * Envía a Meta un mensaje que un agente escribió en la bandeja.
 *
 * La llamada a Meta va FUERA de cualquier transacción: esperar a un tercero
 * con una conexión de la base de datos abierta la agota en cuanto Meta va
 * lento. Se lee, se envía y se escribe el resultado, cada paso por separado.
 *
 * Idempotencia: sólo se envía un mensaje en estado QUEUED, y el resultado se
 * escribe con la condición «sigue en QUEUED». Queda una ventana inevitable
 * —Meta acepta y el worker cae antes de guardarlo— en la que el reintento lo
 * enviaría otra vez; Meta no ofrece clave de idempotencia para evitarlo.
 */
export const whatsappOutboundProcessor = defineProcessor({
  queue: QUEUE_NAMES.WHATSAPP_OUTBOUND,
  schema: whatsappOutboundJobSchema,
  tenantOf: (data) => data.tenantId,

  async handle(data, { job, log }) {
    const message = await runInTenantTransaction((tx) =>
      tx.message.findUnique({
        where: { id: data.messageId },
        select: {
          id: true,
          status: true,
          direction: true,
          body: true,
          conversationId: true,
          conversation: {
            select: { assigneeId: true, contact: { select: { whatsappE164: true } } },
          },
          templateId: true,
          templateParams: true,
          template: { select: { name: true, language: true, status: true } },
          media: {
            select: {
              id: true,
              externalMediaId: true,
              filename: true,
              file: { select: { storageKey: true, mimeType: true, originalName: true } },
            },
            take: 1,
          },
          channel: {
            select: { id: true, status: true, externalId: true, credentialsEncrypted: true },
          },
        },
      }),
    );
    if (!message) throw new UnrecoverableError(`No existe el mensaje ${data.messageId}`);
    if (message.direction !== 'OUTBOUND') {
      throw new UnrecoverableError('Sólo se envían mensajes salientes');
    }
    if (message.status !== 'QUEUED') return { skipped: `ya en estado ${message.status}` };

    const event: RealtimeEvent = {
      type: 'conversation',
      conversationId: message.conversationId,
      assigneeId: message.conversation.assigneeId,
      reason: 'delivery',
    };
    const fail = async (reason: string, code?: number) => {
      await markFailed(message.id, reason, code);
      await publishRealtime(data.tenantId, [event]);
      log.warn({ messageId: message.id, code, reason }, 'Mensaje de WhatsApp no enviado');
      return { failed: reason };
    };

    const { channel } = message;
    const to = message.conversation.contact.whatsappE164?.replace(/\D/g, '');
    if (channel.status !== 'CONNECTED' || !channel.externalId || !channel.credentialsEncrypted) {
      return fail('El canal está desconectado.');
    }
    if (!to) return fail('El contacto no tiene número de WhatsApp.');
    const attachment = message.media[0] ?? null;
    if (!attachment && !message.templateId && !message.body) {
      return fail('El mensaje está vacío.');
    }

    const { accessToken } = JSON.parse(
      decrypt(channel.credentialsEncrypted, env.ENCRYPTION_KEY),
    ) as { accessToken: string };

    let wamid: string;
    try {
      if (message.templateId) {
        // Se comprueba otra vez aquí: entre que el agente la eligió y esto se
        // envía, Meta puede haberla pausado o rechazado.
        if (!message.template) return fail('La plantilla ya no existe.');
        if (message.template.status !== 'APPROVED') {
          return fail(
            `Meta tiene la plantilla en estado ${message.template.status.toLowerCase()}.`,
          );
        }
        const params = (message.templateParams ?? {}) as { variables?: unknown };
        const variables = Array.isArray(params.variables)
          ? params.variables.map((v) => String(v))
          : [];
        wamid = await sendWhatsappTemplate(channel.externalId, accessToken, to, {
          name: message.template.name,
          language: message.template.language,
          variables,
        });
      } else if (attachment) {
        if (!attachment.file || !storage) return fail('El archivo adjunto no está disponible.');
        const kind = mediaKindOf(attachment.file.mimeType);
        if (!kind || kind === 'sticker') return fail('Ese tipo de archivo no se puede enviar.');

        // Si un intento anterior ya lo subió, no se vuelven a mover los bytes:
        // Meta conserva el archivo 30 días.
        let mediaId = attachment.externalMediaId;
        if (!mediaId) {
          const bytes = await storage.getBytes(
            attachment.file.storageKey,
            MEDIA_POLICY[kind].maxBytes,
          );
          mediaId = await uploadWhatsappMedia(
            channel.externalId,
            accessToken,
            bytes,
            attachment.file.mimeType,
            attachment.filename ?? attachment.file.originalName,
          );
          await runInTenantTransaction((tx) =>
            tx.messageMedia.update({
              where: { id: attachment.id },
              data: { externalMediaId: mediaId },
            }),
          );
        }
        wamid = await sendWhatsappMedia(channel.externalId, accessToken, to, {
          type: kind,
          mediaId,
          caption: message.body,
          filename: attachment.filename ?? attachment.file.originalName,
        });
      } else {
        wamid = await sendWhatsappText(channel.externalId, accessToken, to, message.body!);
      }
    } catch (error) {
      if (!(error instanceof GraphSendError)) throw error;
      const lastAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
      if (error.retryable && !lastAttempt) throw error;

      if (error.code === INVALID_TOKEN_CODE) {
        // Todo envío de este canal va a fallar igual: que se vea en Ajustes.
        await runInTenantTransaction((tx) =>
          tx.channel.update({
            where: { id: channel.id },
            data: { lastErrorAt: new Date(), lastErrorMessage: error.message.slice(0, 1000) },
          }),
        );
      }
      return fail(error.message, error.code);
    }

    await runInTenantTransaction(async (tx) => {
      await tx.message.updateMany({
        where: { id: message.id, status: 'QUEUED' },
        data: { status: 'SENT', externalId: wamid, statusUpdatedAt: new Date() },
      });
    });
    await publishRealtime(data.tenantId, [event]);
    log.info({ messageId: message.id }, 'Mensaje de WhatsApp enviado');
    return { sent: wamid };
  },
});

async function markFailed(id: string, reason: string, code?: number): Promise<void> {
  await runInTenantTransaction((tx) =>
    tx.message.updateMany({
      where: { id, status: 'QUEUED' },
      data: {
        status: 'FAILED',
        statusUpdatedAt: new Date(),
        errorCode: code !== undefined ? String(code) : null,
        errorMessage: reason.slice(0, 1000),
      },
    }),
  );
}
