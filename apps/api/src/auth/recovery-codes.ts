import { randomInt } from 'node:crypto';
import { sha256 } from '../common/crypto/tokens';

/**
 * Códigos de recuperación del 2FA: el acceso de emergencia si se pierde el
 * teléfono.
 *
 * Alfabeto sin caracteres que se confunden al copiarlos a mano (0/O, 1/I/L).
 * 10 caracteres de 31 posibles ≈ 49 bits: imposibles de adivinar con el límite
 * de intentos del inicio de sesión. Se guarda su SHA-256 y cada uno sirve una
 * sola vez.
 */
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const RECOVERY_CODE_COUNT = 10;

export function generateRecoveryCodes(): string[] {
  return Array.from({ length: RECOVERY_CODE_COUNT }, () => {
    const chars = Array.from({ length: 10 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
    return `${chars.slice(0, 5)}-${chars.slice(5)}`;
  });
}

export function hashRecoveryCode(code: string): string {
  return sha256(code.trim().toUpperCase());
}
