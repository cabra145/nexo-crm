import { argon2, randomBytes, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const argon2Async = promisify(argon2);

/**
 * Contraseñas con Argon2id (RFC 9106), nativo de Node.
 *
 * Parámetros: los mínimos recomendados por OWASP (19 MiB, 2 pasadas, 1 hilo).
 * Se guardan DENTRO del hash (formato PHC), así que si algún día se endurecen,
 * los hashes antiguos siguen verificándose con los suyos y `needsRehash` avisa
 * para actualizarlos en el siguiente inicio de sesión.
 *
 * La variante asíncrona se ejecuta en el pool de hilos de libuv: calcular un
 * hash (~50 ms a propósito) no bloquea el bucle de eventos de la API.
 */
const PARAMS = { memory: 19_456, passes: 2, parallelism: 1, tagLength: 32 } as const;

const b64 = (buf: Buffer) => buf.toString('base64').replace(/=+$/, '');

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await argon2Async('argon2id', {
    message: Buffer.from(password, 'utf8'),
    nonce: salt,
    ...PARAMS,
  });
  return `$argon2id$v=19$m=${PARAMS.memory},t=${PARAMS.passes},p=${PARAMS.parallelism}$${b64(salt)}$${b64(hash)}`;
}

interface ParsedHash {
  memory: number;
  passes: number;
  parallelism: number;
  salt: Buffer;
  hash: Buffer;
}

function parse(phc: string): ParsedHash | null {
  const match =
    /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/.exec(phc);
  if (!match) return null;
  const [, m, t, p, salt, hash] = match;
  return {
    memory: Number(m),
    passes: Number(t),
    parallelism: Number(p),
    salt: Buffer.from(salt!, 'base64'),
    hash: Buffer.from(hash!, 'base64'),
  };
}

export async function verifyPassword(password: string, phc: string): Promise<boolean> {
  const parsed = parse(phc);
  if (!parsed) return false;
  const candidate = await argon2Async('argon2id', {
    message: Buffer.from(password, 'utf8'),
    nonce: parsed.salt,
    memory: parsed.memory,
    passes: parsed.passes,
    parallelism: parsed.parallelism,
    tagLength: parsed.hash.length,
  });
  return candidate.length === parsed.hash.length && timingSafeEqual(candidate, parsed.hash);
}

/** El hash se hizo con parámetros más débiles que los actuales. */
export function needsRehash(phc: string): boolean {
  const parsed = parse(phc);
  return (
    !parsed ||
    parsed.memory < PARAMS.memory ||
    parsed.passes < PARAMS.passes ||
    parsed.hash.length < PARAMS.tagLength
  );
}
