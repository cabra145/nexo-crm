/**
 * Prueba de extremo a extremo de los archivos que envían los clientes por
 * WhatsApp: del webhook de Meta al almacenamiento, contra la API, el worker y
 * un MinIO REALES, y un simulador de Meta que sirve los datos de cada archivo
 * y su contenido.
 *
 * Cubre: guardado íntegro (bytes y SHA-256) bajo el prefijo de la empresa,
 * tipos y nombres, SHA-256 distinto, contenido disfrazado, tamaño declarado y
 * real por encima del límite, reintento de un fallo temporal, 404 sin
 * reintentos, SSRF (URL de otro dominio, sin enviarle el token), webhook
 * repetido, dos descargas simultáneas del mismo archivo, el id de un archivo
 * de otra empresa, canal desconectado y el aviso en tiempo real. Al final, el
 * bucket sólo contiene los archivos guardados: ni rechazados ni huérfanos.
 *
 *   META_GRAPH_URL=http://127.0.0.1:44200 META_MEDIA_HOSTS=127.0.0.1 \
 *     pnpm --filter @nexo/api media:e2e
 */
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { INBOX_PROBLEMS, type MediaUrlView, QUEUE_NAMES } from '@nexo/contracts';
import { PrismaClient } from '@nexo/database';
import { createObjectStorage, tenantPrefix } from '@nexo/storage';
import { Queue } from 'bullmq';
import {
  API,
  check,
  http,
  type HttpResult,
  section,
  summarize,
  tokenFrom,
  waitForMail,
} from './lib/e2e';

const run = Date.now().toString(36);
const PASSWORD = 'Archivos-Seguros-2026';
const email = (who: string) => `media-${run}-${who}@nexo.test`;
const suffix = String(Date.now()).slice(-6);
const PHONE_A = `5${suffix}01`;
const PHONE_B = `5${suffix}02`;
const TOKEN = `EAAG${'m'.repeat(40)}`;
const SECRET_A = '1'.repeat(32);
const SECRET_B = '2'.repeat(32);
const CLIENT = `5939${suffix}44`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

/* ========================================================================== */
/*  Contenidos de prueba                                                        */
/* ========================================================================== */

const jpeg = () =>
  Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('JFIF'), randomBytes(2048)]);
const ogg = () => Buffer.concat([Buffer.from('OggS'), Buffer.from([0]), randomBytes(4096)]);
const pdf = () => Buffer.concat([Buffer.from('%PDF-1.7\n'), randomBytes(3000)]);
const html = () => Buffer.from('<html><body><script>alert(document.cookie)</script></body></html>');

/* ========================================================================== */
/*  Simulador de Meta                                                           */
/* ========================================================================== */

interface SimMedia {
  /** Número al que pertenece: Meta no lo entrega a otro. */
  owner: string;
  bytes: Buffer;
  mime: string;
  /** Lo que Meta dice; por defecto, lo real. */
  sha256?: string;
  declaredSize?: number;
  /** URL de descarga distinta de la del simulador (prueba de SSRF). */
  url?: string;
  /** Fallos 500 en los datos antes de responder bien. */
  failInfo?: number;
  /** Envía por trozos y sin Content-Length (el contador de bytes decide). */
  chunked?: boolean;
  /** Retraso de la descarga, en ms. */
  delayMs?: number;
}

const medias = new Map<string, SimMedia>();
const infoHits = new Map<string, number>();
const downloadHits = new Map<string, number>();
const bump = (map: Map<string, number>, key: string) => map.set(key, (map.get(key) ?? 0) + 1);
const rogueHits: Array<{ authorization: string | undefined }> = [];
/** Archivos que el agente sube a Meta y mensajes que Meta recibe. */
const uploads: Array<{ id: string; body: Buffer }> = [];
const outbound: Array<Record<string, unknown>> = [];
/** Fallos que el simulador provoca una vez, según el nombre del archivo. */
let failNextUpload = false;
let failNextSend = false;

function startMeta(): Promise<Server> {
  const base = new URL(process.env.META_GRAPH_URL ?? 'http://127.0.0.1:44200');
  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', base);
      const parts = url.pathname.split('/').filter(Boolean);
      const json = (status: number, body: unknown) => {
        res.statusCode = status;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(body));
      };
      if (req.headers.authorization !== `Bearer ${TOKEN}`) {
        return json(401, { error: { message: 'Invalid OAuth access token.', code: 190 } });
      }

      // El agente sube un archivo: POST /{phone}/media (multipart).
      if (req.method === 'POST' && parts[2] === 'media') {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        if (failNextUpload) {
          failNextUpload = false;
          return json(500, { error: { message: 'Upload failed', code: 2 } });
        }
        const id = `meta-subida-${uploads.length + 1}`;
        uploads.push({ id, body: Buffer.concat(chunks) });
        return json(200, { id });
      }

      // El agente envía un mensaje: POST /{phone}/messages.
      if (req.method === 'POST' && parts[2] === 'messages') {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        if (failNextSend) {
          failNextSend = false;
          return json(500, { error: { message: 'Send failed', code: 2 } });
        }
        outbound.push(JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>);
        return json(200, { messages: [{ id: `wamid.saliente.${outbound.length}` }] });
      }

      // Contenido: /descargas/{id}
      if (parts[0] === 'descargas') {
        const id = parts[1]!;
        bump(downloadHits, id);
        const media = medias.get(id);
        if (!media) return json(404, { error: { message: 'Not found' } });
        if (media.delayMs) await sleep(media.delayMs);
        res.statusCode = 200;
        res.setHeader('content-type', media.mime);
        if (media.chunked) {
          for (let i = 0; i < media.bytes.length; i += 64 * 1024) {
            res.write(media.bytes.subarray(i, i + 64 * 1024));
          }
          return res.end();
        }
        return res.end(media.bytes);
      }

      const id = parts[1]!;
      // Alta del número (la API lo consulta al conectar).
      if (id === PHONE_A || id === PHONE_B) {
        return json(200, {
          id,
          display_phone_number: id === PHONE_A ? '+593 99 200 0001' : '+593 99 200 0002',
          verified_name: 'Archivos Prueba',
        });
      }

      // Datos de un archivo: GET /{media-id}?phone_number_id=…
      bump(infoHits, id);
      const media = medias.get(id);
      // Como Meta: sin `phone_number_id`, lo entrega a cualquier token con
      // acceso; con él, sólo si el archivo es de ese número. Justo lo que
      // impide que una empresa recupere el archivo de otra con su id.
      const asked = url.searchParams.get('phone_number_id');
      if (!media || (asked !== null && asked !== media.owner)) {
        return json(400, {
          error: { message: 'Unsupported get request. Object does not exist.', code: 100 },
        });
      }
      if (media.failInfo && media.failInfo > 0) {
        media.failInfo -= 1;
        return json(500, { error: { message: 'An unexpected error has occurred.', code: 2 } });
      }
      json(200, {
        messaging_product: 'whatsapp',
        id,
        url: media.url ?? `${base.origin}/descargas/${id}`,
        mime_type: media.mime,
        sha256: media.sha256 ?? sha(media.bytes),
        file_size: media.declaredSize ?? media.bytes.length,
      });
    })();
  });
  return new Promise((resolve) =>
    server.listen(Number(base.port), base.hostname, () => resolve(server)),
  );
}

/** Otro servidor, en un dominio NO permitido: nunca debe recibir nada. */
function startRogue(): Promise<Server> {
  const server = createServer((req, res) => {
    rogueHits.push({ authorization: req.headers.authorization });
    res.end('robado');
  });
  return new Promise((resolve) => server.listen(44201, 'localhost', () => resolve(server)));
}

/* ========================================================================== */
/*  Meta enviando webhooks                                                      */
/* ========================================================================== */

let tick = 0;
function mediaMessage(
  phoneNumberId: string,
  type: 'image' | 'audio' | 'document',
  mediaId: string,
  mime: string,
  extra: {
    caption?: string;
    filename?: string;
    wamid?: string;
    entryId?: string;
    from?: string;
  } = {},
) {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: extra.entryId ?? 'waba-1',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '593992000001', phone_number_id: phoneNumberId },
              contacts: [{ wa_id: extra.from ?? CLIENT, profile: { name: 'Cliente Archivos' } }],
              messages: [
                {
                  from: extra.from ?? CLIENT,
                  id: extra.wamid ?? `wamid.media.${run}.${++tick}`,
                  timestamp: String(Math.floor(Date.now() / 1000)),
                  type,
                  [type]: {
                    id: mediaId,
                    mime_type: mime,
                    ...(extra.caption ? { caption: extra.caption } : {}),
                    ...(extra.filename ? { filename: extra.filename } : {}),
                  },
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

async function postWebhook(channelId: string, payload: unknown, secret: string): Promise<number> {
  const raw = JSON.stringify(payload);
  const res = await fetch(`${API}/webhooks/whatsapp/${channelId}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-hub-signature-256': `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`,
    },
    body: raw,
  });
  await res.text();
  return res.status;
}

/* ========================================================================== */

interface Session {
  accessToken: string;
  tenantId: string;
  userId: string;
}
const sessionFrom = (res: HttpResult): Session => {
  const body = res.body as {
    accessToken: string;
    user: { id: string };
    activeTenant: { tenantId: string };
  };
  return {
    accessToken: body.accessToken,
    tenantId: body.activeTenant.tenantId,
    userId: body.user.id,
  };
};

async function main(): Promise<void> {
  const db = new PrismaClient({ datasourceUrl: process.env.DIRECT_DATABASE_URL });
  const storage = createObjectStorage({
    NODE_ENV: process.env.NODE_ENV,
    STORAGE_PROVIDER: process.env.STORAGE_PROVIDER as 'minio',
    S3_ENDPOINT: process.env.S3_ENDPOINT,
    S3_BUCKET: process.env.S3_BUCKET,
    S3_ACCESS_KEY: process.env.S3_ACCESS_KEY,
    S3_SECRET_KEY: process.env.S3_SECRET_KEY,
  });
  if (!storage) throw new Error('media:e2e necesita el almacenamiento (S3_*)');
  const url = new URL(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379');
  const mediaQueue = new Queue(QUEUE_NAMES.WHATSAPP_MEDIA, {
    connection: { host: url.hostname, port: Number(url.port || 6379) },
  });
  const meta = await startMeta();
  const rogue = await startRogue();
  const tenantIds: string[] = [];
  const stream = new AbortController();
  console.log(`\nArchivos de WhatsApp de extremo a extremo · ejecución ${run}`);

  async function registerOwner(who: string): Promise<Session> {
    await http('POST', '/auth/register', {
      body: {
        name: `Dueña ${who}`,
        email: email(who),
        password: PASSWORD,
        companyName: `Archivos ${who} ${run}`,
      },
    });
    await http('POST', '/auth/verify-email', {
      body: { token: tokenFrom(await waitForMail(email(who), 'Confirma tu correo')) },
    });
    const session = sessionFrom(
      await http('POST', '/auth/login', { body: { email: email(who), password: PASSWORD } }),
    );
    tenantIds.push(session.tenantId);
    return session;
  }

  async function connect(s: Session, phoneNumberId: string, appSecret: string): Promise<string> {
    const res = await http<{ id: string }>('POST', '/channels/whatsapp', {
      token: s.accessToken,
      body: {
        name: 'Ventas',
        phoneNumberId,
        wabaId: '200000000000077',
        accessToken: TOKEN,
        appSecret,
      },
    });
    if (res.status !== 201) throw new Error(`conectar ${phoneNumberId} → ${res.status}`);
    return res.body.id;
  }

  /** Espera a que el worker termine con el archivo (guardado o rechazado). */
  async function settled(tenantId: string, externalMediaId: string, timeoutMs = 20_000) {
    const until = Date.now() + timeoutMs;
    for (;;) {
      const row = await db.messageMedia.findFirst({
        where: { tenantId, externalMediaId },
        select: {
          id: true,
          fileId: true,
          downloadError: true,
          mimeType: true,
          caption: true,
          filename: true,
          message: { select: { conversationId: true } },
          file: {
            select: {
              storageKey: true,
              mimeType: true,
              sizeBytes: true,
              checksum: true,
              status: true,
              purpose: true,
              originalName: true,
              tenantId: true,
            },
          },
        },
      });
      if (row && (row.fileId || row.downloadError)) return row;
      if (Date.now() > until) return row;
      await sleep(150);
    }
  }

  const events: Array<{ conversationId?: string; reason?: string }> = [];

  try {
    /* ---------------------------------------------------------------------- */
    section('1 · Preparación');
    const a = await registerOwner('a');
    const b = await registerOwner('b');
    const channelA = await connect(a, PHONE_A, SECRET_A);
    const channelB = await connect(b, PHONE_B, SECRET_B);
    check('dos empresas con su número conectado', Boolean(channelA && channelB));

    // Avisos en tiempo real de la empresa A.
    const res = await fetch(`${API}/realtime/stream`, {
      headers: { Authorization: `Bearer ${a.accessToken}` },
      signal: stream.signal,
    });
    void (async () => {
      const reader = (res.body as ReadableStream<Uint8Array>).getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let i: number;
          while ((i = buffer.indexOf('\n\n')) >= 0) {
            const block = buffer.slice(0, i);
            buffer = buffer.slice(i + 2);
            const data = /^data: (.*)$/m.exec(block)?.[1];
            if (/^event: conversation$/m.test(block) && data) {
              events.push(JSON.parse(data) as (typeof events)[number]);
            }
          }
        }
      } catch {
        // cerrada al terminar
      }
    })();

    /* ---------------------------------------------------------------------- */
    section('2 · Una foto: se guarda íntegra, en la carpeta de su empresa');
    const photo = jpeg();
    medias.set('media-foto', { owner: PHONE_A, bytes: photo, mime: 'image/jpeg' });
    await postWebhook(
      channelA,
      mediaMessage(PHONE_A, 'image', 'media-foto', 'image/jpeg', { caption: 'Así llegó la caja' }),
      SECRET_A,
    );
    const foto = await settled(a.tenantId, 'media-foto');
    check('el archivo queda guardado', Boolean(foto?.fileId), foto?.downloadError ?? '');
    const key = foto?.file?.storageKey ?? '';
    check(
      `bajo tenants/{su empresa}/whatsapp-media/…, con extensión jpg`,
      key.startsWith(`${tenantPrefix(a.tenantId)}whatsapp-media/`) && key.endsWith('.jpg'),
      key,
    );
    check(
      'File READY, de WhatsApp, de su empresa, con tipo, tamaño y SHA-256 reales',
      foto?.file?.status === 'READY' &&
        foto.file.purpose === 'WHATSAPP_MEDIA' &&
        foto.file.tenantId === a.tenantId &&
        foto.file.mimeType === 'image/jpeg' &&
        foto.file.sizeBytes === photo.length &&
        foto.file.checksum === sha(photo),
    );
    const stored = key ? await storage.getBytes(key, 10 * 1024 * 1024) : Buffer.alloc(0);
    check(
      'el objeto en el almacenamiento tiene exactamente los mismos bytes',
      stored.equals(photo),
    );
    check('se conserva el pie de foto', foto?.caption === 'Así llegó la caja');
    const conversationId = foto?.message.conversationId;
    let notified = false;
    for (let i = 0; i < 40 && !notified; i++) {
      notified =
        events.filter((e) => e.conversationId === conversationId && e.reason === 'message')
          .length >= 2;
      if (!notified) await sleep(100);
    }
    check(
      'la bandeja recibe un aviso cuando el archivo queda listo (además del del mensaje)',
      notified,
    );

    /* ---------------------------------------------------------------------- */
    section('3 · Nota de voz y documento con nombre');
    const voice = ogg();
    medias.set('media-voz', { owner: PHONE_A, bytes: voice, mime: 'audio/ogg; codecs=opus' });
    await postWebhook(
      channelA,
      mediaMessage(PHONE_A, 'audio', 'media-voz', 'audio/ogg; codecs=opus'),
      SECRET_A,
    );
    const voz = await settled(a.tenantId, 'media-voz');
    check(
      'nota de voz: audio/ogg, extensión ogg',
      voz?.file?.mimeType === 'audio/ogg' && Boolean(voz.file.storageKey.endsWith('.ogg')),
      voz?.downloadError ?? voz?.file?.mimeType ?? '',
    );
    const doc = pdf();
    medias.set('media-pdf', { owner: PHONE_A, bytes: doc, mime: 'application/pdf' });
    await postWebhook(
      channelA,
      mediaMessage(PHONE_A, 'document', 'media-pdf', 'application/pdf', {
        filename: 'Cotización 2026.pdf',
      }),
      SECRET_A,
    );
    const cot = await settled(a.tenantId, 'media-pdf');
    check(
      'documento: PDF con su nombre original (sólo para mostrar; la clave no lo usa)',
      cot?.file?.mimeType === 'application/pdf' &&
        cot.file.originalName === 'Cotización 2026.pdf' &&
        !cot.file.storageKey.includes('Cotiz'),
    );

    /* ---------------------------------------------------------------------- */
    section('4 · Integridad y tipo real');
    medias.set('media-sha', {
      owner: PHONE_A,
      bytes: jpeg(),
      mime: 'image/jpeg',
      sha256: sha(Buffer.from('otra cosa')),
    });
    await postWebhook(
      channelA,
      mediaMessage(PHONE_A, 'image', 'media-sha', 'image/jpeg'),
      SECRET_A,
    );
    const badSha = await settled(a.tenantId, 'media-sha');
    check(
      'SHA-256 distinto del de Meta → rechazado, sin archivo',
      !badSha?.fileId && /SHA-256/.test(badSha?.downloadError ?? ''),
      badSha?.downloadError ?? '',
    );
    const fake = html();
    medias.set('media-html', { owner: PHONE_A, bytes: fake, mime: 'image/jpeg' });
    await postWebhook(
      channelA,
      mediaMessage(PHONE_A, 'image', 'media-html', 'image/jpeg'),
      SECRET_A,
    );
    const disguised = await settled(a.tenantId, 'media-html');
    check(
      'un HTML que Meta anuncia como JPEG → rechazado por su contenido',
      !disguised?.fileId && /no es del tipo declarado/.test(disguised?.downloadError ?? ''),
      disguised?.downloadError ?? '',
    );
    medias.set('media-pdf-foto', { owner: PHONE_A, bytes: pdf(), mime: 'image/jpeg' });
    await postWebhook(
      channelA,
      mediaMessage(PHONE_A, 'image', 'media-pdf-foto', 'image/jpeg'),
      SECRET_A,
    );
    const crossKind = await settled(a.tenantId, 'media-pdf-foto');
    check(
      'un PDF anunciado como imagen → rechazado (tipo admitido, pero de otra categoría)',
      !crossKind?.fileId && /no es del tipo declarado/.test(crossKind?.downloadError ?? ''),
      crossKind?.downloadError ?? '',
    );

    /* ---------------------------------------------------------------------- */
    section('5 · Tamaño');
    medias.set('media-grande', {
      owner: PHONE_A,
      bytes: jpeg(),
      mime: 'image/jpeg',
      declaredSize: 6 * 1024 * 1024,
    });
    await postWebhook(
      channelA,
      mediaMessage(PHONE_A, 'image', 'media-grande', 'image/jpeg'),
      SECRET_A,
    );
    const big = await settled(a.tenantId, 'media-grande');
    check(
      'declarada de 6 MB → rechazada SIN descargarla',
      !big?.fileId &&
        /supera el máximo de 5 MB/.test(big?.downloadError ?? '') &&
        !downloadHits.has('media-grande'),
      `${big?.downloadError ?? ''} · descargas ${downloadHits.get('media-grande') ?? 0}`,
    );
    const huge = Buffer.concat([
      Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
      randomBytes(5 * 1024 * 1024 + 100),
    ]);
    medias.set('media-miente', {
      owner: PHONE_A,
      bytes: huge,
      mime: 'image/jpeg',
      declaredSize: 1000,
      chunked: true,
    });
    await postWebhook(
      channelA,
      mediaMessage(PHONE_A, 'image', 'media-miente', 'image/jpeg'),
      SECRET_A,
    );
    const lied = await settled(a.tenantId, 'media-miente');
    check(
      'declara 1 KB pero envía más de 5 MB → la descarga se corta',
      !lied?.fileId && /supera el máximo/.test(lied?.downloadError ?? ''),
      lied?.downloadError ?? '',
    );

    /* ---------------------------------------------------------------------- */
    section('6 · Fallos de Meta');
    const retried = jpeg();
    medias.set('media-500', { owner: PHONE_A, bytes: retried, mime: 'image/jpeg', failInfo: 1 });
    await postWebhook(
      channelA,
      mediaMessage(PHONE_A, 'image', 'media-500', 'image/jpeg'),
      SECRET_A,
    );
    const recovered = await settled(a.tenantId, 'media-500', 40_000);
    check(
      'un 500 de Meta se reintenta y el archivo termina guardado',
      Boolean(recovered?.fileId) && infoHits.get('media-500') === 2,
      `${recovered?.downloadError ?? ''} · peticiones ${infoHits.get('media-500')}`,
    );
    await postWebhook(
      channelA,
      mediaMessage(PHONE_A, 'image', 'media-no-existe', 'image/jpeg'),
      SECRET_A,
    );
    const missing = await settled(a.tenantId, 'media-no-existe');
    const missingJob = missing ? await mediaQueue.getJob(missing.id) : undefined;
    check(
      'Meta no lo encuentra → error definitivo en el primer intento, sin reintentos',
      /no encuentra el archivo/.test(missing?.downloadError ?? '') &&
        missingJob?.attemptsMade === 1,
      `${missing?.downloadError ?? ''} · intentos ${missingJob?.attemptsMade}`,
    );

    /* ---------------------------------------------------------------------- */
    section('7 · SSRF: sólo se descarga de Meta');
    medias.set('media-ssrf', {
      owner: PHONE_A,
      bytes: jpeg(),
      mime: 'image/jpeg',
      url: 'http://localhost:44201/robar',
    });
    await postWebhook(
      channelA,
      mediaMessage(PHONE_A, 'image', 'media-ssrf', 'image/jpeg'),
      SECRET_A,
    );
    const ssrf = await settled(a.tenantId, 'media-ssrf');
    check(
      'una URL de otro dominio → no se descarga',
      !ssrf?.fileId && /dominio no permitido/.test(ssrf?.downloadError ?? ''),
      ssrf?.downloadError ?? '',
    );
    check('el otro servidor no recibió ninguna petición (ni el token)', rogueHits.length === 0);

    /* ---------------------------------------------------------------------- */
    section('8 · Idempotencia');
    const again = jpeg();
    medias.set('media-repetida', { owner: PHONE_A, bytes: again, mime: 'image/jpeg' });
    const wamid = `wamid.repetido.${run}`;
    await postWebhook(
      channelA,
      mediaMessage(PHONE_A, 'image', 'media-repetida', 'image/jpeg', { wamid }),
      SECRET_A,
    );
    await settled(a.tenantId, 'media-repetida');
    // El mismo mensaje en otro cuerpo (no lo para la deduplicación del webhook).
    await postWebhook(
      channelA,
      mediaMessage(PHONE_A, 'image', 'media-repetida', 'image/jpeg', { wamid, entryId: 'waba-2' }),
      SECRET_A,
    );
    await sleep(1500);
    check(
      'Meta repite el mensaje → un solo archivo y una sola descarga',
      (await db.file.count({ where: { tenantId: a.tenantId, checksum: sha(again) } })) === 1 &&
        downloadHits.get('media-repetida') === 1,
      `descargas ${downloadHits.get('media-repetida')}`,
    );

    const slow = jpeg();
    medias.set('media-lenta', { owner: PHONE_A, bytes: slow, mime: 'image/jpeg', delayMs: 1500 });
    await postWebhook(
      channelA,
      mediaMessage(PHONE_A, 'image', 'media-lenta', 'image/jpeg'),
      SECRET_A,
    );
    let slowRow: { id: string } | null = null;
    for (let i = 0; i < 50 && !slowRow; i++) {
      slowRow = await db.messageMedia.findFirst({
        where: { tenantId: a.tenantId, externalMediaId: 'media-lenta' },
        select: { id: true },
      });
      if (!slowRow) await sleep(100);
    }
    if (!slowRow) throw new Error('el worker no creó la fila del archivo lento');
    // Un segundo trabajo del MISMO archivo mientras el primero descarga.
    await mediaQueue.add(
      QUEUE_NAMES.WHATSAPP_MEDIA,
      { mediaId: slowRow.id, tenantId: a.tenantId },
      { jobId: `${slowRow.id}-copia` },
    );
    await settled(a.tenantId, 'media-lenta');
    await sleep(2500);
    check(
      'dos descargas simultáneas del mismo archivo → un solo File enlazado',
      (await db.file.count({ where: { tenantId: a.tenantId, checksum: sha(slow) } })) === 1 &&
        downloadHits.get('media-lenta') === 2,
      `descargas ${downloadHits.get('media-lenta')}`,
    );

    /* ---------------------------------------------------------------------- */
    section('9 · Aislamiento entre empresas');
    // B conoce el id del archivo de A y lo manda por SU número.
    await postWebhook(
      channelB,
      mediaMessage(PHONE_B, 'image', 'media-foto', 'image/jpeg'),
      SECRET_B,
    );
    const stolen = await settled(b.tenantId, 'media-foto');
    check(
      'la empresa B no obtiene el archivo de A con su id (Meta: no es de su número)',
      !stolen?.fileId && /no encuentra el archivo/.test(stolen?.downloadError ?? ''),
      stolen?.downloadError ?? '',
    );
    check(
      'B no tiene ningún archivo, y el de A sigue siendo sólo de A',
      (await db.file.count({ where: { tenantId: b.tenantId } })) === 0 &&
        (await db.file.count({ where: { checksum: sha(photo) } })) === 1,
    );
    const forged = await mediaQueue.add(
      QUEUE_NAMES.WHATSAPP_MEDIA,
      { mediaId: foto!.id, tenantId: b.tenantId },
      { jobId: `falso-${run}` },
    );
    let forgedState = '';
    for (let i = 0; i < 50 && !['failed', 'completed'].includes(forgedState); i++) {
      await sleep(100);
      forgedState = await forged.getState();
    }
    check(
      'un trabajo con el archivo de A y la empresa B → no encuentra nada (RLS)',
      forgedState === 'failed',
      forgedState,
    );

    // Canal desconectado: no se llama a Meta.
    await http('DELETE', `/channels/${channelB}`, { token: b.accessToken });
    const message = await db.message.findFirstOrThrow({
      where: { tenantId: b.tenantId },
      select: { id: true },
    });
    const orphan = await db.messageMedia.create({
      data: {
        tenantId: b.tenantId,
        messageId: message.id,
        externalMediaId: 'media-desconectado',
        mimeType: 'image/jpeg',
      },
    });
    await mediaQueue.add(
      QUEUE_NAMES.WHATSAPP_MEDIA,
      { mediaId: orphan.id, tenantId: b.tenantId },
      { jobId: orphan.id },
    );
    const offline = await settled(b.tenantId, 'media-desconectado');
    check(
      'canal desconectado → error definitivo sin llamar a Meta',
      /desconectado/.test(offline?.downloadError ?? '') && !infoHits.has('media-desconectado'),
      offline?.downloadError ?? '',
    );

    /* ---------------------------------------------------------------------- */
    section('11 · Descargas con URL firmada');
    const mediaUrl = (s: Session, conversation: string, media: string) =>
      http<MediaUrlView>('GET', `/conversations/${conversation}/media/${media}/url`, {
        token: s.accessToken,
      });

    const signed = await mediaUrl(a, conversationId!, foto!.id);
    check(
      'una imagen: URL firmada, para mostrarla en el navegador',
      signed.status === 200 &&
        signed.body.disposition === 'inline' &&
        signed.body.mimeType === 'image/jpeg' &&
        signed.body.url.includes('X-Amz-Signature'),
      `${signed.status} ${signed.body.disposition}`,
    );
    const expiresIn = Number(new URL(signed.body.url).searchParams.get('X-Amz-Expires'));
    const declaredExpiry = new Date(signed.body.expiresAt).getTime() - Date.now();
    check(
      'caduca en 5 minutos, y lo dice la respuesta',
      expiresIn === 300 && declaredExpiry > 240_000 && declaredExpiry <= 300_000,
      `${expiresIn}s · ${Math.round(declaredExpiry / 1000)}s`,
    );

    // Sin cabecera de sesión: el navegador la usa tal cual.
    const download = await fetch(signed.body.url);
    const downloaded = Buffer.from(await download.arrayBuffer());
    check(
      'la descarga funciona sin sesión y trae los bytes exactos',
      download.status === 200 && downloaded.equals(photo),
      `${download.status} · ${downloaded.length} bytes`,
    );
    check(
      'el almacenamiento sirve el tipo y la entrega que fijó el servidor',
      download.headers.get('content-type') === 'image/jpeg' &&
        (download.headers.get('content-disposition') ?? '').startsWith('inline'),
      `${download.headers.get('content-type')} · ${download.headers.get('content-disposition')}`,
    );

    const signedPdf = await mediaUrl(a, conversationId!, cot!.id);
    const pdfDownload = await fetch(signedPdf.body.url);
    await pdfDownload.arrayBuffer();
    check(
      'un PDF se DESCARGA, con su nombre en UTF-8',
      signedPdf.body.disposition === 'attachment' &&
        (pdfDownload.headers.get('content-disposition') ?? '').includes(
          "filename*=UTF-8''Cotizaci%C3%B3n",
        ),
      pdfDownload.headers.get('content-disposition') ?? '',
    );

    // La firma cubre lo que decide el servidor.
    const tampered = signedPdf.body.url.replace('attachment', 'inline');
    const tamperedRes = await fetch(tampered);
    await tamperedRes.arrayBuffer();
    const otherKey = signed.body.url.replace(
      /\/[0-9a-f-]{36}\.jpg/,
      '/00000000-0000-7000-8000-000000000000.jpg',
    );
    const otherKeyRes = await fetch(otherKey);
    await otherKeyRes.arrayBuffer();
    check(
      'cambiar la entrega o la clave rompe la firma (403)',
      tamperedRes.status === 403 && otherKeyRes.status === 403,
      `${tamperedRes.status} · ${otherKeyRes.status}`,
    );

    const shortLived = await storage.signedGetUrl(foto!.file!.storageKey, {
      expiresInSeconds: 1,
      contentType: 'image/jpeg',
      disposition: 'inline',
      filename: 'foto.jpg',
    });
    await sleep(2000);
    const expired = await fetch(shortLived);
    await expired.arrayBuffer();
    check('una URL caducada ya no sirve (403)', expired.status === 403, `${expired.status}`);

    section('12 · Quién puede pedir una URL');
    const rejected = await mediaUrl(a, conversationId!, badSha!.id);
    check(
      'un archivo rechazado → 409 con su motivo',
      rejected.status === 409 &&
        (rejected.body as unknown as { type: string }).type === INBOX_PROBLEMS.MEDIA_NOT_READY &&
        /SHA-256/.test((rejected.body as unknown as { detail: string }).detail),
      `${rejected.status}`,
    );
    const pendingMessage = await db.message.findFirstOrThrow({
      where: { tenantId: a.tenantId, conversationId: conversationId! },
      select: { id: true },
    });
    const pendingMedia = await db.messageMedia.create({
      data: {
        tenantId: a.tenantId,
        messageId: pendingMessage.id,
        externalMediaId: `media-pendiente-${run}`,
        mimeType: 'image/jpeg',
      },
      select: { id: true },
    });
    const pending = await mediaUrl(a, conversationId!, pendingMedia.id);
    check(
      'un archivo aún sin descargar → 409, sin URL',
      pending.status === 409 && !('url' in pending.body),
      `${pending.status}`,
    );

    // Un archivo que SÍ existe pero aún no está comprobado (así quedan las
    // subidas del agente hasta que se confirman): tampoco se firma.
    const notReadyFile = await db.file.create({
      data: {
        tenantId: a.tenantId,
        storageKey: `${tenantPrefix(a.tenantId)}attachment/2026/09/${randomUUID()}.jpg`,
        originalName: 'a-medias.jpg',
        mimeType: 'image/jpeg',
        sizeBytes: 10,
        purpose: 'ATTACHMENT',
        status: 'PENDING',
        // El bucket real: si no, la limpieza lo saltaría por eso y la prueba
        // no comprobaría lo que dice comprobar.
        bucket: storage.bucket,
      },
      select: { id: true },
    });
    const notReadyMedia = await db.messageMedia.create({
      data: {
        tenantId: a.tenantId,
        messageId: pendingMessage.id,
        externalMediaId: `media-a-medias-${run}`,
        mimeType: 'image/jpeg',
        fileId: notReadyFile.id,
      },
      select: { id: true },
    });
    const notReady = await mediaUrl(a, conversationId!, notReadyMedia.id);
    check(
      'un archivo enlazado pero aún sin comprobar (PENDING) → 409, sin URL',
      notReady.status === 409 && !('url' in notReady.body),
      `${notReady.status}`,
    );

    // Otra empresa, por los dos caminos.
    const fromB = await mediaUrl(b, conversationId!, foto!.id);
    const bConversation = await db.conversation.findFirstOrThrow({
      where: { tenantId: b.tenantId },
      select: { id: true },
    });
    const crossed = await mediaUrl(b, bConversation.id, foto!.id);
    check(
      'otra empresa no obtiene la URL, ni con la conversación de A ni con la suya',
      fromB.status === 404 && crossed.status === 404,
      `${fromB.status} · ${crossed.status}`,
    );

    // Otra conversación de la MISMA empresa.
    const otherClient = `5939${suffix}55`;
    await postWebhook(
      channelA,
      mediaMessage(PHONE_A, 'image', 'media-otra', 'image/jpeg', { from: otherClient }),
      SECRET_A,
    );
    let otherConversation: { id: string } | null = null;
    for (let i = 0; i < 60 && !otherConversation; i++) {
      otherConversation = await db.conversation.findFirst({
        where: { tenantId: a.tenantId, contact: { whatsappE164: `+${otherClient}` } },
        select: { id: true },
      });
      if (!otherConversation) await sleep(200);
    }
    if (!otherConversation) throw new Error('no se creó la segunda conversación');
    const wrongConversation = await mediaUrl(a, otherConversation.id, foto!.id);
    check(
      'el archivo de otra conversación de la misma empresa → 404',
      wrongConversation.status === 404,
      `${wrongConversation.status}`,
    );

    // Permisos dentro de la empresa.
    const pro = await db.plan.findUniqueOrThrow({ where: { code: 'pro' } });
    await db.subscription.update({ where: { tenantId: a.tenantId }, data: { planId: pro.id } });
    const roles = await http<{ roles: Array<{ id: string; key: string }> }>('GET', '/team/roles', {
      token: a.accessToken,
    });
    const viewerRole = roles.body.roles.find((r) => r.key === 'VIEWER')!.id;
    const limitedRole = await http<{ id: string }>('POST', '/team/roles', {
      token: a.accessToken,
      body: {
        name: 'Sólo las suyas',
        permissions: { 'conversation:read': 'OWN', 'conversation:write': 'OWN' },
      },
    });
    const member = async (who: string, roleId: string): Promise<Session> => {
      await http('POST', '/team/invitations', {
        token: a.accessToken,
        body: { email: email(who), roleId },
      });
      const token = tokenFrom(await waitForMail(email(who), 'te invita'));
      return sessionFrom(
        await http('POST', '/invitations/accept-new', {
          body: { token, name: `Persona ${who}`, password: PASSWORD },
        }),
      );
    };
    const viewer = await member('visor', viewerRole);
    const limited = await member('limitada', limitedRole.body.id);

    const byViewer = await mediaUrl(viewer, conversationId!, foto!.id);
    check('quien no puede ver conversaciones → 403', byViewer.status === 403, `${byViewer.status}`);
    const beforeAssign = await mediaUrl(limited, conversationId!, foto!.id);
    await http('POST', `/conversations/${conversationId!}/assign`, {
      token: a.accessToken,
      body: { userId: a.userId },
    });
    const afterAssign = await mediaUrl(limited, conversationId!, foto!.id);
    check(
      'quien sólo ve las suyas: sin asignar sí, asignada a otra persona → 404',
      beforeAssign.status === 200 && afterAssign.status === 404,
      `${beforeAssign.status} → ${afterAssign.status}`,
    );

    section('13 · Los mensajes no filtran nada');
    const messages = await http<{
      data: Array<{ media: { status: string; error: string | null } | null }>;
    }>('GET', `/conversations/${conversationId!}/messages?limit=100`, { token: a.accessToken });
    const withMedia = messages.body.data.filter((m) => m.media);
    check(
      'cada mensaje con archivo trae su estado (listos y rechazados)',
      withMedia.some((m) => m.media!.status === 'ready') &&
        withMedia.some((m) => m.media!.status === 'failed' && m.media!.error),
      `${withMedia.length} con archivo`,
    );
    const raw = JSON.stringify(messages.body);
    check(
      'no aparecen ni la clave del almacenamiento ni ninguna URL',
      !raw.includes('tenants/') && !raw.includes('storageKey') && !raw.includes('X-Amz'),
    );

    section('15 · Adjuntos que envía el agente');
    const reserve = (s: Session, conversation: string, body: Record<string, unknown>) =>
      http<{ fileId: string; url: string; headers: Record<string, string>; expiresAt: string }>(
        'POST',
        `/conversations/${conversation}/uploads`,
        { token: s.accessToken, body },
      );
    const put = (url: string, headers: Record<string, string>, bytes: Buffer) =>
      fetch(url, { method: 'PUT', headers, body: new Uint8Array(bytes) });
    const send = (s: Session, conversation: string, body: Record<string, unknown>) =>
      http<{ id: string; type: string; media: { status: string } | null }>(
        'POST',
        `/conversations/${conversation}/messages`,
        { token: s.accessToken, body },
      );
    const messageStatus = async (id: string, timeoutMs = 30_000) => {
      const until = Date.now() + timeoutMs;
      for (;;) {
        const row = await db.message.findUnique({
          where: { id },
          select: { status: true, errorMessage: true, externalId: true },
        });
        if (row && ['SENT', 'FAILED'].includes(row.status)) return row;
        if (Date.now() > until) return row;
        await sleep(150);
      }
    };

    const agentPhoto = jpeg();
    const reserved = await reserve(a, conversationId!, {
      filename: 'catálogo.jpg',
      mimeType: 'image/jpeg',
      sizeBytes: agentPhoto.length,
    });
    check(
      'reservar devuelve una URL de subida firmada y la cabecera obligatoria',
      reserved.status === 201 &&
        reserved.body.url.includes('X-Amz-Signature') &&
        reserved.body.headers['Content-Type'] === 'image/jpeg',
      `${reserved.status}`,
    );

    const wrongType = await put(reserved.body.url, { 'Content-Type': 'text/plain' }, agentPhoto);
    const wrongSize = await put(
      reserved.body.url,
      reserved.body.headers,
      Buffer.concat([agentPhoto, Buffer.from('de más')]),
    );
    check(
      'subir con otro tipo o con otro tamaño → rechazado por el almacenamiento',
      wrongType.status === 403 && wrongSize.status === 403,
      `${wrongType.status} · ${wrongSize.status}`,
    );

    const uploaded = await put(reserved.body.url, reserved.body.headers, agentPhoto);
    check(
      'la subida con el tipo y tamaño firmados funciona',
      uploaded.status === 200,
      `${uploaded.status}`,
    );

    const sentPhoto = await send(a, conversationId!, {
      fileId: reserved.body.fileId,
      body: 'Este es el catálogo',
    });
    check(
      'enviar con el archivo → mensaje de tipo IMAGE con su adjunto listo',
      sentPhoto.status === 201 &&
        sentPhoto.body.type === 'IMAGE' &&
        sentPhoto.body.media?.status === 'ready',
      `${sentPhoto.status} ${sentPhoto.body.type}`,
    );
    const delivered = await messageStatus(sentPhoto.body.id);
    const upload = uploads.at(-1);
    const metaMessage = outbound.at(-1) as
      { type?: string; image?: { id?: string; caption?: string } } | undefined;
    check(
      'el worker sube a Meta los MISMOS bytes y envía el mensaje con ese id y su pie',
      delivered?.status === 'SENT' &&
        Boolean(upload && upload.body.includes(agentPhoto)) &&
        metaMessage?.type === 'image' &&
        metaMessage.image?.id === upload?.id &&
        metaMessage.image?.caption === 'Este es el catálogo',
      `${delivered?.status} · ${delivered?.errorMessage ?? ''}`,
    );

    const reused = await send(a, conversationId!, {
      fileId: reserved.body.fileId,
      body: 'otra vez',
    });
    check(
      'el mismo archivo no se puede enviar dos veces → 409',
      reused.status === 409 &&
        (reused.body as unknown as { type: string }).type === INBOX_PROBLEMS.UPLOAD_USED,
      `${reused.status}`,
    );

    section('16 · Lo que manda es el contenido subido, no lo declarado');
    const disguisedBytes = html();
    const disguisedReserve = await reserve(a, conversationId!, {
      filename: 'inocente.jpg',
      mimeType: 'image/jpeg',
      sizeBytes: disguisedBytes.length,
    });
    await put(disguisedReserve.body.url, disguisedReserve.body.headers, disguisedBytes);
    const disguisedSend = await send(a, conversationId!, { fileId: disguisedReserve.body.fileId });
    const disguisedFile = await db.file.findUniqueOrThrow({
      where: { id: disguisedReserve.body.fileId },
      select: { status: true, storageKey: true, rejectReason: true },
    });
    check(
      'un HTML subido como JPEG → 400, archivo REJECTED y objeto borrado',
      disguisedSend.status === 400 &&
        (disguisedSend.body as unknown as { type: string }).type ===
          INBOX_PROBLEMS.UPLOAD_INVALID &&
        disguisedFile.status === 'REJECTED' &&
        (await storage.head(disguisedFile.storageKey)) === null,
      `${disguisedSend.status} · ${disguisedFile.status}`,
    );

    const neverUploaded = await reserve(a, conversationId!, {
      filename: 'fantasma.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 1000,
    });
    const ghost = await send(a, conversationId!, { fileId: neverUploaded.body.fileId });
    check(
      'enviar un archivo que nunca se subió → 400',
      ghost.status === 400 &&
        /no se completó/.test((ghost.body as unknown as { detail: string }).detail),
      `${ghost.status}`,
    );

    const badReserves = await Promise.all([
      reserve(a, conversationId!, { filename: 'a.gif', mimeType: 'image/gif', sizeBytes: 100 }),
      reserve(a, conversationId!, {
        filename: 'b.jpg',
        mimeType: 'image/jpeg',
        sizeBytes: 6 * 1024 * 1024,
      }),
      reserve(a, conversationId!, { filename: 'c.webp', mimeType: 'image/webp', sizeBytes: 100 }),
    ]);
    check(
      'reservar un GIF, algo de 6 MB o un sticker → 400 sin crear nada',
      badReserves.every((r) => r.status === 400),
      badReserves.map((r) => r.status).join(','),
    );

    const voiceBytes = ogg();
    const voiceReserve = await reserve(a, conversationId!, {
      filename: 'nota.ogg',
      mimeType: 'audio/ogg',
      sizeBytes: voiceBytes.length,
    });
    await put(voiceReserve.body.url, voiceReserve.body.headers, voiceBytes);
    const withCaption = await send(a, conversationId!, {
      fileId: voiceReserve.body.fileId,
      body: 'escucha esto',
    });
    const voiceSent = await send(a, conversationId!, { fileId: voiceReserve.body.fileId });
    check(
      'un audio con texto → 400, y sin texto se envía (el archivo no se descarta)',
      withCaption.status === 400 && voiceSent.status === 201 && voiceSent.body.type === 'AUDIO',
      `${withCaption.status} → ${voiceSent.status}`,
    );

    section('17 · Permisos, aislamiento y reintentos del envío');
    const byViewerReserve = await reserve(viewer, conversationId!, {
      filename: 'x.jpg',
      mimeType: 'image/jpeg',
      sizeBytes: 100,
    });
    check(
      'quien no puede responder no reserva → 403',
      byViewerReserve.status === 403,
      `${byViewerReserve.status}`,
    );

    const agentA = await member('agente', roles.body.roles.find((r) => r.key === 'AGENT')!.id);
    const agentBytes = jpeg();
    const agentReserve = await reserve(agentA, conversationId!, {
      filename: 'de-otro.jpg',
      mimeType: 'image/jpeg',
      sizeBytes: agentBytes.length,
    });
    await put(agentReserve.body.url, agentReserve.body.headers, agentBytes);
    const stolenUpload = await send(a, conversationId!, { fileId: agentReserve.body.fileId });
    check(
      'el archivo reservado por otra persona no se puede adjuntar → 404',
      stolenUpload.status === 404,
      `${stolenUpload.status}`,
    );
    const fromOtherTenant = await send(b, bConversation.id, { fileId: agentReserve.body.fileId });
    check(
      'ni desde otra empresa → 404 o 409',
      [404, 409].includes(fromOtherTenant.status),
      `${fromOtherTenant.status}`,
    );

    const disconnected = await reserve(b, bConversation.id, {
      filename: 'y.jpg',
      mimeType: 'image/jpeg',
      sizeBytes: 100,
    });
    check(
      'con el canal desconectado no se puede ni reservar → 409',
      disconnected.status === 409,
      `${disconnected.status}`,
    );

    // Meta acepta la subida pero falla el envío: al reintentar NO se vuelve a subir.
    const retryBytes = jpeg();
    const retryReserve = await reserve(a, conversationId!, {
      filename: 'reintento.jpg',
      mimeType: 'image/jpeg',
      sizeBytes: retryBytes.length,
    });
    await put(retryReserve.body.url, retryReserve.body.headers, retryBytes);
    failNextSend = true;
    const uploadsBefore = uploads.length;
    const retrySend = await send(a, conversationId!, { fileId: retryReserve.body.fileId });
    const resent = await messageStatus(retrySend.body.id, 40_000);
    check(
      'si Meta falla al enviar, se reintenta y el archivo NO se sube dos veces',
      resent?.status === 'SENT' && uploads.length === uploadsBefore + 1,
      `${resent?.status} · subidas ${uploads.length - uploadsBefore}`,
    );

    section('18 · Límite de reservas pendientes');
    let limitStatus = 0;
    let reservesDone = 0;
    for (let i = 0; i < 12 && limitStatus !== 429; i++) {
      const r = await reserve(a, conversationId!, {
        filename: `cola-${i}.jpg`,
        mimeType: 'image/jpeg',
        sizeBytes: 100,
      });
      limitStatus = r.status;
      if (r.status === 201) reservesDone += 1;
    }
    check(
      'a las 10 reservas sin terminar, la siguiente → 429',
      limitStatus === 429 && reservesDone <= 10,
      `${reservesDone} reservas antes del 429`,
    );
    // Las pendientes no tienen objeto: se limpian aquí (y, en producción, el
    // trabajo periódico del paso 7).
    // Sin enlazar: un archivo enlazado no se borra suelto (clave foránea del
    // paso 2), y aquí hay uno a propósito, de la sección 12.
    // Sólo las de este caso: no tienen objeto. Otras reservas pendientes sí lo
    // tienen (una subida que nunca se envió) y deben seguir ahí para la
    // comprobación final.
    await db.file.deleteMany({
      where: { tenantId: a.tenantId, status: 'PENDING', originalName: { startsWith: 'cola-' } },
    });

    section('19 · Limpieza de subidas abandonadas');
    const maintenance = new Queue(QUEUE_NAMES.MAINTENANCE, {
      connection: { host: url.hostname, port: Number(url.port || 6379) },
    });
    /** Lanza la limpieza de un archivo sin esperar las 24 h del aplazamiento. */
    const runCleanup = async (fileId: string, tenantId: string, label: string) => {
      const job = await maintenance.add(
        QUEUE_NAMES.MAINTENANCE,
        { fileId, tenantId },
        { jobId: `ahora-${label}-${run}` },
      );
      for (let i = 0; i < 100; i++) {
        const state = await job.getState();
        if (state === 'completed' || state === 'failed') return state;
        await sleep(150);
      }
      return 'timeout';
    };

    const abandonedBytes = jpeg();
    const abandoned = await reserve(a, conversationId!, {
      filename: 'abandonada.jpg',
      mimeType: 'image/jpeg',
      sizeBytes: abandonedBytes.length,
    });
    await put(abandoned.body.url, abandoned.body.headers, abandonedBytes);
    const abandonedRow = await db.file.findUniqueOrThrow({
      where: { id: abandoned.body.fileId },
      select: { storageKey: true },
    });

    // Reservar programa el trabajo aplazado, uno por archivo.
    const scheduled = await maintenance.getJob(`limpieza-${abandoned.body.fileId}`);
    const scheduledState = await scheduled?.getState();
    check(
      'reservar programa su limpieza, aplazada 24 h',
      scheduledState === 'delayed' && Math.abs((scheduled?.opts.delay ?? 0) - 24 * 3600_000) < 1000,
      `${scheduledState} · ${scheduled?.opts.delay}`,
    );

    // Aún reciente: al saltar, no borra nada.
    const tooSoon = await runCleanup(abandoned.body.fileId, a.tenantId, 'pronto');
    check(
      'si todavía no ha pasado el plazo, no se borra nada',
      tooSoon === 'completed' &&
        (await db.file.count({ where: { id: abandoned.body.fileId } })) === 1,
      tooSoon,
    );

    // Pasadas las 24 h: objeto y fila fuera.
    await db.file.update({
      where: { id: abandoned.body.fileId },
      data: { createdAt: new Date(Date.now() - 48 * 3600 * 1000) },
    });
    const cleaned = await runCleanup(abandoned.body.fileId, a.tenantId, 'vieja');
    check(
      'pasado el plazo desaparecen la fila y el objeto',
      cleaned === 'completed' &&
        (await db.file.count({ where: { id: abandoned.body.fileId } })) === 0 &&
        (await storage.head(abandonedRow.storageKey)) === null,
      cleaned,
    );

    // Lo que NUNCA se toca.
    const readyKey = foto!.file!.storageKey;
    const readyFile = await db.file.findFirstOrThrow({
      where: { storageKey: readyKey },
      select: { id: true },
    });
    // Envejecido a propósito: lo que tiene que salvarlo es su ESTADO, no su
    // fecha (sin esto, la prueba pasaba aunque se quitara la guarda).
    await db.file.update({
      where: { id: readyFile.id },
      data: { createdAt: new Date(Date.now() - 48 * 3600 * 1000) },
    });
    const readyCleanup = await runCleanup(readyFile.id, a.tenantId, 'guardado');
    check(
      'un archivo ya guardado y viejo no se toca',
      readyCleanup === 'completed' &&
        (await db.file.count({ where: { id: readyFile.id, status: 'READY' } })) === 1 &&
        (await storage.head(readyKey)) !== null,
      readyCleanup,
    );
    await db.file.update({
      where: { id: notReadyFile.id },
      data: { createdAt: new Date(Date.now() - 48 * 3600 * 1000) },
    });
    const linkedCleanup = await runCleanup(notReadyFile.id, a.tenantId, 'enlazada');
    check(
      // Que TERMINE bien: si la limpieza intentara borrarla, chocaría con la
      // clave foránea y el trabajo fallaría. Sobrevivir no basta.
      'una reserva enlazada a un mensaje se deja en paz, sin siquiera intentarlo',
      linkedCleanup === 'completed' &&
        (await db.file.count({ where: { id: notReadyFile.id, status: 'PENDING' } })) === 1,
      linkedCleanup,
    );

    // Aislamiento: con la empresa equivocada no encuentra nada (RLS).
    const agentFile = await db.file.findFirstOrThrow({
      where: { tenantId: a.tenantId, originalName: 'de-otro.jpg' },
      select: { id: true, storageKey: true },
    });
    await db.file.update({
      where: { id: agentFile.id },
      data: { createdAt: new Date(Date.now() - 48 * 3600 * 1000) },
    });
    await runCleanup(agentFile.id, b.tenantId, 'otra-empresa');
    check(
      'con la empresa equivocada no borra nada: la RLS no le deja verlo',
      (await db.file.count({ where: { id: agentFile.id } })) === 1 &&
        (await storage.head(agentFile.storageKey)) !== null,
    );
    const ownCleanup = await runCleanup(agentFile.id, a.tenantId, 'propia');
    check(
      'con su empresa, sí',
      ownCleanup === 'completed' && (await db.file.count({ where: { id: agentFile.id } })) === 0,
      ownCleanup,
    );
    await maintenance.close();

    section('14 · El bucket y la base cuadran');
    for (const s of [a, b]) {
      const keys = new Set(await storage.listKeys(tenantPrefix(s.tenantId)));
      const files = await db.file.findMany({
        where: { tenantId: s.tenantId },
        select: { storageKey: true, status: true },
      });
      const ready = files.filter((f) => f.status === 'READY').map((f) => f.storageKey);
      const pending = files.filter((f) => f.status === 'PENDING').map((f) => f.storageKey);
      const rejected = files.filter((f) => f.status === 'REJECTED').map((f) => f.storageKey);
      const label = s === a ? 'A' : 'B';

      // Todo objeto tiene su fila: guardado, o reserva subida y aún sin enviar
      // (la recoge la limpieza del paso 7). Nada huérfano.
      const orphans = [...keys].filter((k) => !ready.includes(k) && !pending.includes(k));
      check(
        `empresa ${label}: ningún objeto sin su fila`,
        orphans.length === 0,
        orphans.join(', '),
      );
      // Y todo archivo guardado tiene su objeto.
      const missing = ready.filter((k) => !keys.has(k));
      check(
        `empresa ${label}: todo archivo guardado tiene su objeto`,
        missing.length === 0,
        missing.join(', '),
      );
      // Lo rechazado se borra en el momento.
      check(
        `empresa ${label}: nada de lo rechazado sigue en el bucket`,
        rejected.every((k) => !keys.has(k)),
        `${rejected.length} rechazados`,
      );
    }
  } finally {
    stream.abort();
    for (const tenantId of tenantIds) {
      const keys = await storage.listKeys(tenantPrefix(tenantId)).catch(() => []);
      await storage.delete(keys).catch(() => undefined);
    }
    await db.tenant.deleteMany({ where: { id: { in: tenantIds } } }).catch(() => undefined);
    await db.$disconnect();
    await mediaQueue.close();
    await new Promise((r) => meta.close(r));
    await new Promise((r) => rogue.close(r));
  }

  summarize('Archivos de WhatsApp de extremo a extremo superados.');
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
