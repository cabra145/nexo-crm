import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Cifrado en reposo con AES-256-GCM y la clave maestra ENCRYPTION_KEY.
 *
 * Lo usan la API y el worker para los secretos que la base de datos guarda
 * pero NO debe poder leer quien la vea: el secreto TOTP de cada usuario, los
 * tokens de WhatsApp de cada empresa, los secretos de webhook.
 *
 * GCM autentica además de cifrar: un valor alterado en la base de datos no se
 * descifra "mal", se rechaza.
 *
 * Formato: v1.<iv>.<tag>.<cifrado>, cada parte en base64url. El prefijo de
 * versión permite rotar la clave o el algoritmo en el futuro sin ambigüedad.
 */
const VERSION = 'v1';
const IV_BYTES = 12; // recomendado para GCM

function key(hex: string): Buffer {
  const buf = Buffer.from(hex, 'hex');
  if (buf.length !== 32) throw new Error('ENCRYPTION_KEY debe tener 32 bytes (64 caracteres hex)');
  return buf;
}

export function encrypt(plaintext: string, encryptionKeyHex: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key(encryptionKeyHex), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv, tag, ciphertext]
    .map((p) => (typeof p === 'string' ? p : p.toString('base64url')))
    .join('.');
}

export function decrypt(payload: string, encryptionKeyHex: string): string {
  const [version, iv, tag, ciphertext] = payload.split('.');
  if (version !== VERSION || !iv || !tag || !ciphertext) {
    throw new Error('Valor cifrado con un formato desconocido');
  }
  const decipher = createDecipheriv(
    'aes-256-gcm',
    key(encryptionKeyHex),
    Buffer.from(iv, 'base64url'),
  );
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertext, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}
