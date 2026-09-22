/**
 * Política de archivos: qué se admite, hasta qué tamaño y cómo se entrega.
 *
 * Una sola definición para la web (valida antes de subir y arma el `accept`
 * del selector), la API (valida al reservar y al confirmar una subida) y el
 * worker (valida lo que llega de WhatsApp). El TIPO real lo detecta
 * @nexo/storage por número mágico; esto decide si ese tipo se admite.
 *
 * Los tipos son los que acepta WhatsApp Cloud API. Todo lo demás se rechaza.
 */

export const MEDIA_KINDS = ['image', 'sticker', 'audio', 'video', 'document'] as const;
export type MediaKind = (typeof MEDIA_KINDS)[number];

const MB = 1024 * 1024;
const KB = 1024;

interface KindPolicy {
  /** Tipo de mensaje de WhatsApp (MessageType) con el que se envía. */
  messageType: 'IMAGE' | 'STICKER' | 'AUDIO' | 'VIDEO' | 'DOCUMENT';
  maxBytes: number;
  /** Tipo MIME → extensión de la clave en el almacenamiento. */
  types: Record<string, string>;
  /** Nombre para los mensajes de error. */
  label: string;
}

export const MEDIA_POLICY: Record<MediaKind, KindPolicy> = {
  image: {
    messageType: 'IMAGE',
    maxBytes: 5 * MB,
    types: { 'image/jpeg': 'jpg', 'image/png': 'png' },
    label: 'la imagen',
  },
  sticker: {
    messageType: 'STICKER',
    // Meta: 100 KB los estáticos y 500 KB los animados. Se admite el mayor.
    maxBytes: 500 * KB,
    types: { 'image/webp': 'webp' },
    label: 'el sticker',
  },
  audio: {
    messageType: 'AUDIO',
    maxBytes: 16 * MB,
    // audio/ogg sólo con códec Opus (las notas de voz lo son); el códec no se
    // comprueba aquí: si Meta lo rechaza, el mensaje queda fallido con su motivo.
    types: {
      'audio/aac': 'aac',
      'audio/amr': 'amr',
      'audio/mpeg': 'mp3',
      'audio/mp4': 'm4a',
      'audio/ogg': 'ogg',
    },
    label: 'el audio',
  },
  video: {
    messageType: 'VIDEO',
    maxBytes: 16 * MB,
    types: { 'video/mp4': 'mp4', 'video/3gpp': '3gp' },
    label: 'el vídeo',
  },
  document: {
    messageType: 'DOCUMENT',
    // Meta admite 100 MB. En este bloque el worker procesa cada archivo en
    // memoria: 25 MB por trabajo. Subirlo exige subida por partes y en flujo.
    maxBytes: 25 * MB,
    types: {
      'application/pdf': 'pdf',
      'text/plain': 'txt',
      'application/msword': 'doc',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
      'application/vnd.ms-excel': 'xls',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
      'application/vnd.ms-powerpoint': 'ppt',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
    },
    label: 'el documento',
  },
};

/** Todos los tipos admitidos. */
export const ALLOWED_MEDIA_TYPES: string[] = MEDIA_KINDS.flatMap((kind) =>
  Object.keys(MEDIA_POLICY[kind].types),
);

/** Para el atributo `accept` del selector de archivos de la web. */
export const ACCEPT_ATTRIBUTE = ALLOWED_MEDIA_TYPES.join(',');

/** Sin parámetros (`; codecs=opus`) y en minúsculas. */
const normalize = (mime: string): string => mime.split(';')[0]!.trim().toLowerCase();

/** Categoría de un tipo, o null si no se admite. */
export function mediaKindOf(mime: string): MediaKind | null {
  const type = normalize(mime);
  return MEDIA_KINDS.find((kind) => type in MEDIA_POLICY[kind].types) ?? null;
}

/** Extensión de la clave en el almacenamiento. Nunca sale del nombre original. */
export function extensionFor(mime: string): string | null {
  const kind = mediaKindOf(mime);
  return kind ? MEDIA_POLICY[kind].types[normalize(mime)]! : null;
}

/**
 * Cómo se entrega la descarga firmada.
 *
 * Sólo se muestran en el navegador imágenes, stickers, audio y vídeo. Todo lo
 * demás se DESCARGA: un PDF puede llevar JavaScript, y no debe abrirse desde el
 * dominio del almacenamiento; texto y Office tampoco se interpretan. Un tipo
 * desconocido, también se descarga.
 */
export function dispositionFor(mime: string): 'inline' | 'attachment' {
  const kind = mediaKindOf(mime);
  return kind === 'image' || kind === 'sticker' || kind === 'audio' || kind === 'video'
    ? 'inline'
    : 'attachment';
}

/** «5 MB», «500 KB», «1,5 MB». */
export function formatBytes(bytes: number): string {
  if (bytes >= MB) {
    const value = bytes / MB;
    return `${Number.isInteger(value) ? value : value.toFixed(1).replace('.', ',')} MB`;
  }
  if (bytes >= KB) return `${Math.round(bytes / KB)} KB`;
  return `${bytes} B`;
}

/**
 * Lo que un agente puede ENVIAR. Los stickers se reciben, pero no se envían:
 * Meta exige un WebP con medidas y peso muy concretos, y rechazaría casi
 * cualquier imagen que alguien adjunte desde el ordenador.
 */
export const SENDABLE_KINDS: MediaKind[] = ['image', 'audio', 'video', 'document'];
export const canSend = (kind: MediaKind): boolean => SENDABLE_KINDS.includes(kind);

/** WhatsApp sólo muestra pie en imagen, vídeo y documento. */
export const allowsCaption = (kind: MediaKind): boolean =>
  kind === 'image' || kind === 'video' || kind === 'document';

/** Etiqueta para la vista previa de la bandeja: «Imagen», «Documento»… */
export const MEDIA_LABELS: Record<MediaKind, string> = {
  image: 'Imagen',
  sticker: 'Sticker',
  audio: 'Audio',
  video: 'Vídeo',
  document: 'Documento',
};

export type MediaCheck =
  | { ok: true; kind: MediaKind; messageType: KindPolicy['messageType']; extension: string }
  | { ok: false; reason: string };

/**
 * ¿Se admite un archivo de este tipo y tamaño? El tipo tiene que ser el REAL
 * (el detectado), no el declarado: esta función no lo comprueba.
 */
export function checkMedia(input: { mime: string; sizeBytes: number }): MediaCheck {
  const kind = mediaKindOf(input.mime);
  if (!kind) {
    return {
      ok: false,
      reason:
        'tipo de archivo no admitido por WhatsApp: se aceptan imágenes JPG o PNG, audio, vídeo MP4, PDF, texto y documentos de Office',
    };
  }
  const policy = MEDIA_POLICY[kind];
  if (!Number.isInteger(input.sizeBytes) || input.sizeBytes <= 0) {
    return { ok: false, reason: 'el archivo está vacío' };
  }
  if (input.sizeBytes > policy.maxBytes) {
    return {
      ok: false,
      reason: `${policy.label} supera el máximo de ${formatBytes(policy.maxBytes)} (tiene ${formatBytes(input.sizeBytes)})`,
    };
  }
  return {
    ok: true,
    kind,
    messageType: policy.messageType,
    extension: policy.types[normalize(input.mime)]!,
  };
}
