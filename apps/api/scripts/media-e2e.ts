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
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { QUEUE_NAMES } from '@nexo/contracts';
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
  extra: { caption?: string; filename?: string; wamid?: string; entryId?: string } = {},
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
              contacts: [{ wa_id: CLIENT, profile: { name: 'Cliente Archivos' } }],
              messages: [
                {
                  from: CLIENT,
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
}
const sessionFrom = (res: HttpResult): Session => {
  const body = res.body as { accessToken: string; activeTenant: { tenantId: string } };
  return { accessToken: body.accessToken, tenantId: body.activeTenant.tenantId };
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
    section('10 · El bucket sólo tiene lo guardado');
    for (const s of [a, b]) {
      const keys = (await storage.listKeys(tenantPrefix(s.tenantId))).sort();
      const files = (
        await db.file.findMany({
          where: { tenantId: s.tenantId, status: 'READY' },
          select: { storageKey: true },
        })
      )
        .map((f) => f.storageKey)
        .sort();
      check(
        `empresa ${s === a ? 'A' : 'B'}: cada objeto es un archivo READY y al revés (ni rechazados ni huérfanos)`,
        JSON.stringify(keys) === JSON.stringify(files),
        `${keys.length} objetos · ${files.length} archivos`,
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
