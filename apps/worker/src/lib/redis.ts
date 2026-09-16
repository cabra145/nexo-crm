import Redis from 'ioredis';
import { env } from '../bootstrap/env';
import { logger } from './logger';

/**
 * Conexión de Redis para BullMQ.
 *
 * `maxRetriesPerRequest: null` es OBLIGATORIO en las conexiones de un Worker:
 * BullMQ usa comandos bloqueantes (esperar el siguiente trabajo) que pueden
 * durar indefinidamente, y con un límite de reintentos ioredis los cortaría y
 * el worker dejaría de recibir trabajos sin dar ningún error.
 */
export function createRedisConnection(): Redis {
  const log = logger.child({ component: 'redis' });

  const connection = new Redis(env.REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    connectionName: 'nexo-worker',
    retryStrategy: (attempt) => Math.min(attempt * 250, 5_000),
  });

  // Un aviso al caer y otro al volver, no uno por cada reintento.
  let degraded = false;
  connection.on('ready', () => {
    log.info(degraded ? 'Conexión con Redis recuperada' : 'Conectado a Redis');
    degraded = false;
  });
  connection.on('error', (error) => {
    if (degraded) return;
    degraded = true;
    log.warn(
      { err: error.message },
      'Sin conexión con Redis; reintentando. ¿Está levantado Docker? → ' +
        'docker compose --env-file .env -f infra/compose.yml up -d',
    );
  });

  return connection;
}
