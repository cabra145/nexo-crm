/**
 * Pone a cero el límite de inicios de sesión POR IP entre dos suites del CI.
 *
 * Todas las pruebas entran desde 127.0.0.1, aunque cada una simula a personas
 * distintas: sumadas, pasan de los 50 intentos cada 15 minutos que se permiten
 * a una IP, y la suite que va detrás recibe 429 por lo que hizo la anterior.
 * El límite es correcto; lo que no lo es, es que una suite herede el estado de
 * otra. Esto la deja empezar limpia, igual que empieza con sus propios datos.
 *
 * Sólo toca `login-ip`: los bloqueos por cuenta (`login-fail`) no se cruzan
 * entre suites y se quedan como estén.
 *
 *   pnpm --filter @nexo/api exec tsx scripts/reset-login-ip-limits.ts
 */
import Redis from 'ioredis';

const url = process.env.REDIS_URL;
if (!url) throw new Error('Falta REDIS_URL');

async function main(): Promise<void> {
  const redis = new Redis(url!, { maxRetriesPerRequest: 2 });
  let removed = 0;
  let cursor = '0';
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', 'nexo:auth:login-ip:*', 'COUNT', 500);
    cursor = next;
    if (keys.length > 0) removed += await redis.del(...keys);
  } while (cursor !== '0');
  await redis.quit();
  console.log(`Límite de inicio de sesión por IP reiniciado (${removed} contador(es))`);
}

void main();
