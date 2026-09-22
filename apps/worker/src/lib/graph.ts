import { formatBytes } from '@nexo/contracts';
import { env } from '../bootstrap/env';

/**
 * Error de la Graph API de Meta, con lo necesario para decidir si reintentar.
 *
 * `retryable`: la red, un 5xx o un límite de tasa pasan solos; un token
 * inválido, un número que no existe o la ventana de 24 h cerrada, no, y
 * reintentarlos sólo retrasaría el aviso al agente.
 */
export class GraphSendError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly code?: number,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'GraphSendError';
  }
}

/**
 * Códigos de Meta que son límites de tasa: se reintentan.
 * 4 y 80007: límite de la app o de la cuenta; 130429: rendimiento del número;
 * 131048: límite por spam; 131056: demasiados mensajes al mismo destinatario.
 */
const RATE_LIMIT_CODES = new Set([4, 80007, 130429, 131048, 131056]);

/** Token inválido o caducado: el canal necesita que alguien lo reconecte. */
export const INVALID_TOKEN_CODE = 190;

/**
 * Envía un texto por WhatsApp Cloud API y devuelve el id del mensaje (wamid).
 *
 * `to` son los dígitos del número, sin «+» (así lo espera Meta).
 */
export function sendWhatsappText(
  phoneNumberId: string,
  accessToken: string,
  to: string,
  body: string,
): Promise<string> {
  return sendMessage(phoneNumberId, accessToken, {
    to,
    type: 'text',
    text: { preview_url: false, body },
  });
}

/** Envía un mensaje ya compuesto y devuelve su wamid. */
async function sendMessage(
  phoneNumberId: string,
  accessToken: string,
  message: Record<string, unknown>,
): Promise<string> {
  const url = `${env.META_GRAPH_URL.replace(/\/$/, '')}/${env.META_GRAPH_VERSION}/${phoneNumberId}/messages`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        ...message,
      }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (cause) {
    throw new GraphSendError(`No se pudo contactar con Meta: ${(cause as Error).message}`, true);
  }

  const payload = (await response.json().catch(() => ({}))) as {
    messages?: Array<{ id?: string }>;
    error?: { message?: string; code?: number; error_data?: { details?: string } };
  };

  if (!response.ok) {
    const code = payload.error?.code;
    const detail = payload.error?.error_data?.details;
    const text = [payload.error?.message ?? `Meta respondió ${response.status}`, detail]
      .filter(Boolean)
      .join(' — ');
    const retryable =
      response.status >= 500 ||
      response.status === 429 ||
      (code !== undefined && RATE_LIMIT_CODES.has(code));
    throw new GraphSendError(text, retryable, code, response.status);
  }

  const wamid = payload.messages?.[0]?.id;
  if (!wamid) throw new GraphSendError('Meta aceptó el mensaje pero no devolvió su id', false);
  return wamid;
}

/* ========================================================================== */
/*  Envío de archivos                                                         */
/* ========================================================================== */

/**
 * Sube un archivo a Meta y devuelve su id. Meta lo guarda 30 días, así que el
 * id se conserva: un reintento del envío no vuelve a subir los bytes.
 */
export async function uploadWhatsappMedia(
  phoneNumberId: string,
  accessToken: string,
  bytes: Buffer,
  mimeType: string,
  filename: string,
): Promise<string> {
  const url = `${env.META_GRAPH_URL.replace(/\/$/, '')}/${env.META_GRAPH_VERSION}/${phoneNumberId}/media`;
  const form = new FormData();
  form.set('messaging_product', 'whatsapp');
  form.set('type', mimeType);
  // Uint8Array.from y no el Buffer: el tipo de Blob exige un búfer propio.
  form.set('file', new Blob([Uint8Array.from(bytes)], { type: mimeType }), filename);

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}` },
      body: form,
      signal: AbortSignal.timeout(120_000),
    });
  } catch (cause) {
    throw new GraphSendError(
      `No se pudo subir el archivo a Meta: ${(cause as Error).message}`,
      true,
    );
  }

  const payload = (await response.json().catch(() => ({}))) as {
    id?: string;
    error?: { message?: string; code?: number };
  };
  if (!response.ok || !payload.id) {
    const code = payload.error?.code;
    const retryable =
      response.status >= 500 ||
      response.status === 429 ||
      (code !== undefined && RATE_LIMIT_CODES.has(code));
    throw new GraphSendError(
      payload.error?.message ?? `Meta respondió ${response.status} al subir el archivo`,
      retryable,
      code,
      response.status,
    );
  }
  return payload.id;
}

/** Envía un mensaje con un archivo ya subido a Meta. */
export function sendWhatsappMedia(
  phoneNumberId: string,
  accessToken: string,
  to: string,
  media: {
    type: 'image' | 'audio' | 'video' | 'document';
    mediaId: string;
    caption?: string | null;
    filename?: string | null;
  },
): Promise<string> {
  return sendMessage(phoneNumberId, accessToken, {
    to,
    type: media.type,
    [media.type]: {
      id: media.mediaId,
      // Meta sólo admite pie en imagen, vídeo y documento.
      ...(media.caption && media.type !== 'audio' ? { caption: media.caption } : {}),
      ...(media.type === 'document' && media.filename ? { filename: media.filename } : {}),
    },
  });
}

/* ========================================================================== */
/*  Archivos que envían los clientes                                          */
/* ========================================================================== */

/**
 * No se pudo obtener un archivo de Meta. `retryable` como en `GraphSendError`:
 * la red, un 5xx o un límite de tasa se reintentan; lo demás es definitivo.
 */
export class MediaFetchError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'MediaFetchError';
  }
}

export interface MediaInfo {
  /** URL de descarga. Caduca en minutos: se pide en cada intento. */
  url: string;
  mimeType: string;
  /** SHA-256 del contenido, en hexadecimal, según Meta. */
  sha256: string;
  sizeBytes: number;
}

const retryableStatus = (status: number, code?: number) =>
  status >= 500 || status === 429 || (code !== undefined && RATE_LIMIT_CODES.has(code));

/**
 * Datos de un archivo de Meta. Se piden CON el número del canal
 * (`phone_number_id`): Meta sólo entrega el archivo si pertenece a ese número,
 * así que una empresa no puede recuperar el de otra conociendo su id.
 */
export async function getMediaInfo(
  mediaId: string,
  phoneNumberId: string,
  accessToken: string,
): Promise<MediaInfo> {
  const base = `${env.META_GRAPH_URL.replace(/\/$/, '')}/${env.META_GRAPH_VERSION}`;
  const url = `${base}/${encodeURIComponent(mediaId)}?phone_number_id=${encodeURIComponent(phoneNumberId)}`;

  let response: Response;
  try {
    response = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    });
  } catch (cause) {
    throw new MediaFetchError(`No se pudo contactar con Meta: ${(cause as Error).message}`, true);
  }

  const payload = (await response.json().catch(() => ({}))) as {
    url?: unknown;
    mime_type?: unknown;
    sha256?: unknown;
    file_size?: unknown;
    error?: { message?: string; code?: number };
  };
  if (!response.ok) {
    const code = payload.error?.code;
    const message =
      response.status === 404 || code === 100
        ? 'Meta no encuentra el archivo (o no es de este número)'
        : (payload.error?.message ?? `Meta respondió ${response.status}`);
    throw new MediaFetchError(message, retryableStatus(response.status, code));
  }

  const size = Number(payload.file_size);
  if (
    typeof payload.url !== 'string' ||
    typeof payload.mime_type !== 'string' ||
    typeof payload.sha256 !== 'string' ||
    !/^[0-9a-f]{64}$/i.test(payload.sha256) ||
    !Number.isInteger(size) ||
    size < 0
  ) {
    throw new MediaFetchError('Meta devolvió los datos del archivo incompletos', false);
  }
  return {
    url: payload.url,
    mimeType: payload.mime_type,
    sha256: payload.sha256.toLowerCase(),
    sizeBytes: size,
  };
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * ¿Se puede descargar de esta URL? Sólo de los dominios de META_MEDIA_HOSTS, y
 * por https salvo hacia la propia máquina. La petición lleva el token de la
 * empresa: pedirle algo a otro dominio sería entregárselo (SSRF).
 */
export function isAllowedMediaUrl(raw: string, allowedHosts: readonly string[]): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.username || url.password) return false;
  const host = url.hostname.toLowerCase();
  const secure = url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK.has(host));
  return secure && allowedHosts.includes(host);
}

/**
 * Descarga el contenido con el token, sin seguir redirecciones (una redirección
 * podría llevar el token a otro dominio) y contando bytes: se corta en cuanto
 * se supera `maxBytes`, aunque Meta hubiera declarado menos.
 */
export async function downloadMedia(
  rawUrl: string,
  accessToken: string,
  maxBytes: number,
): Promise<Buffer> {
  if (!isAllowedMediaUrl(rawUrl, env.META_MEDIA_HOSTS)) {
    let host = '(URL inválida)';
    try {
      host = new URL(rawUrl).host;
    } catch {
      // queda el texto por defecto
    }
    throw new MediaFetchError(`Meta indicó descargar de un dominio no permitido: ${host}`, false);
  }

  let response: Response;
  try {
    response = await fetch(rawUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
      redirect: 'error',
      signal: AbortSignal.timeout(60_000),
    });
  } catch (cause) {
    throw new MediaFetchError(`No se pudo descargar el archivo: ${(cause as Error).message}`, true);
  }
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new MediaFetchError(
      `La descarga respondió ${response.status}`,
      retryableStatus(response.status),
    );
  }

  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body.cancel();
    throw new MediaFetchError(`El archivo supera el máximo de ${formatBytes(maxBytes)}`, false);
  }

  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new MediaFetchError(`El archivo supera el máximo de ${formatBytes(maxBytes)}`, false);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}
