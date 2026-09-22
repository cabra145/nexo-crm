/**
 * Tipo REAL de un archivo por sus primeros bytes (número mágico).
 *
 * El tipo que declara el navegador o el nombre del archivo lo decide quien lo
 * sube; esto no. Un HTML renombrado a «foto.jpg» no pasa por imagen.
 *
 * Sólo reconoce los formatos que Nexo admite: lo demás es `null` y se rechaza.
 */

/** Bytes necesarios para reconocer cualquiera de los formatos. */
export const SNIFF_BYTES = 4096;

const startsWith = (bytes: Uint8Array, signature: number[], offset = 0) =>
  signature.every((b, i) => bytes[offset + i] === b);
const ascii = (bytes: Uint8Array, from: number, to: number) =>
  String.fromCharCode(...bytes.subarray(from, to));

export function sniffMime(bytes: Uint8Array): string | null {
  if (bytes.length < 4) return null;

  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (ascii(bytes, 0, 6) === 'GIF87a' || ascii(bytes, 0, 6) === 'GIF89a') return 'image/gif';
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 12) === 'WEBP') return 'image/webp';
  if (ascii(bytes, 0, 5) === '%PDF-') return 'application/pdf';
  if (ascii(bytes, 0, 4) === 'OggS') return 'audio/ogg';
  if (ascii(bytes, 0, 5) === '#!AMR') return 'audio/amr';
  if (ascii(bytes, 0, 3) === 'ID3') return 'audio/mpeg';
  // Trama MPEG de audio (sin etiqueta ID3): 11 bits de sincronía.
  if (bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0) {
    // ADTS (AAC) tiene la capa a 00; MP3, no.
    return (bytes[1]! & 0x06) === 0 ? 'audio/aac' : 'audio/mpeg';
  }
  if (ascii(bytes, 4, 8) === 'ftyp') {
    const brand = ascii(bytes, 8, 12);
    if (brand === 'M4A ' || brand === 'M4B ') return 'audio/mp4';
    if (brand.startsWith('3gp') || brand.startsWith('3g2')) return 'video/3gpp';
    return 'video/mp4';
  }
  // Contenedores: ZIP (docx, xlsx, pptx) y OLE (doc, xls, ppt). El tipo exacto
  // de Office se acepta si el declarado es uno de los de su familia.
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) return 'application/zip';
  if (startsWith(bytes, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) {
    return 'application/x-ole-storage';
  }
  if (isPlainText(bytes)) return 'text/plain';
  return null;
}

const OFFICE_ZIP = new Set([
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
]);
const OFFICE_OLE = new Set([
  'application/msword',
  'application/vnd.ms-excel',
  'application/vnd.ms-powerpoint',
]);

/**
 * El tipo con el que se guarda el archivo: el detectado, afinado con el
 * declarado sólo dentro de la misma familia. null = no coinciden; se rechaza.
 */
export function resolveMime(
  declared: string | null | undefined,
  sniffed: string | null,
): string | null {
  if (!sniffed) return null;
  const d = declared?.split(';')[0]?.trim().toLowerCase();
  if (sniffed === 'application/zip') return d && OFFICE_ZIP.has(d) ? d : null;
  if (sniffed === 'application/x-ole-storage') return d && OFFICE_OLE.has(d) ? d : null;
  // Mismo contenedor, distinta etiqueta habitual.
  if (sniffed === 'video/mp4' && d === 'audio/mp4') return 'audio/mp4';
  if (sniffed === 'audio/mpeg' && d === 'audio/mp3') return 'audio/mpeg';
  return sniffed;
}

/** UTF-8 válido, sin bytes nulos ni caracteres de control (salvo tab y saltos). */
function isPlainText(bytes: Uint8Array): boolean {
  const sample = bytes.subarray(0, Math.min(bytes.length, SNIFF_BYTES));
  for (const b of sample) {
    if (b === 0 || (b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d)) return false;
  }
  try {
    // Se recorta al final una secuencia UTF-8 cortada por el límite de bytes.
    new TextDecoder('utf-8', { fatal: true }).decode(trimPartialUtf8(sample));
    return true;
  } catch {
    return false;
  }
}

function trimPartialUtf8(bytes: Uint8Array): Uint8Array {
  const end = bytes.length;
  for (let i = 1; i <= 3 && end - i >= 0; i++) {
    const b = bytes[end - i]!;
    if ((b & 0xc0) === 0xc0) return bytes.subarray(0, end - i);
    if ((b & 0xc0) !== 0x80) break;
  }
  return bytes;
}
