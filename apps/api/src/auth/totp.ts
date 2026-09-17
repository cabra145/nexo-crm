import { createHmac, randomBytes } from 'node:crypto';

/**
 * TOTP (RFC 6238) sobre HOTP (RFC 4226), compatible con cualquier autenticador:
 * Google Authenticator, 1Password, Authy, Microsoft Authenticator.
 *
 * Implementado aquí y no con una librería porque el algoritmo es corto y está
 * completamente especificado. Se valida contra los vectores de prueba
 * oficiales de RFC 6238 en scripts/crypto-selftest.ts, que corre en CI.
 *
 * SHA-1, 30 segundos, 6 dígitos: los valores que asumen todos los
 * autenticadores. Cambiar cualquiera rompería la compatibilidad.
 */
const STEP_SECONDS = 30;
const DIGITS = 6;
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(input: string): Buffer {
  const clean = input.replace(/=+$/, '').replace(/\s+/g, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of clean) {
    const index = BASE32.indexOf(char);
    if (index === -1) throw new Error('Secreto base32 inválido');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** 20 bytes (160 bits), el tamaño que recomienda RFC 4226 para SHA-1. */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export function hotp(secret: Buffer, counter: number, digits = DIGITS, algorithm = 'sha1'): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac(algorithm, secret).update(msg).digest();
  // Truncamiento dinámico (RFC 4226 §5.3)
  const offset = hmac[hmac.length - 1]! & 0x0f;
  const binary =
    ((hmac[offset]! & 0x7f) << 24) |
    (hmac[offset + 1]! << 16) |
    (hmac[offset + 2]! << 8) |
    hmac[offset + 3]!;
  return String(binary % 10 ** digits).padStart(digits, '0');
}

export function currentStep(nowMs = Date.now()): number {
  return Math.floor(nowMs / 1000 / STEP_SECONDS);
}

/**
 * Verifica un código aceptando ±1 intervalo (±30 s) de desfase de reloj.
 *
 * Devuelve el intervalo que coincidió, o null. Quien llama debe impedir que el
 * mismo intervalo se use dos veces: si no, un código visto por encima del
 * hombro serviría durante hasta 90 segundos.
 */
export function verifyTotp(base32Secret: string, code: string, nowMs = Date.now()): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const secret = base32Decode(base32Secret);
  const step = currentStep(nowMs);
  for (const candidate of [step, step - 1, step + 1]) {
    if (hotp(secret, candidate) === code) return candidate;
  }
  return null;
}

export function otpauthUrl(params: { secret: string; account: string; issuer: string }): string {
  const label = encodeURIComponent(`${params.issuer}:${params.account}`);
  const query = new URLSearchParams({
    secret: params.secret,
    issuer: params.issuer,
    algorithm: 'SHA1',
    digits: String(DIGITS),
    period: String(STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${query.toString()}`;
}
