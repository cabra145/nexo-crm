import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Tokens opacos para enlaces de un solo uso y sesiones de refresco.
 *
 * 32 bytes aleatorios: 256 bits de entropía, imposibles de adivinar. En la
 * base de datos sólo se guarda su SHA-256: quien lea la tabla no obtiene
 * tokens utilizables. Un hash rápido basta aquí —a diferencia de las
 * contraseñas— porque el valor original no tiene estructura que atacar.
 */
export function generateToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** Comparación en tiempo constante: no filtra por cuánto tarda cuántos caracteres coinciden. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
