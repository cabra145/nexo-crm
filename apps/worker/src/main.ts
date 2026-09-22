// Primero, antes que nada: carga y valida el entorno. Ver bootstrap/env.ts.
import { env } from './bootstrap/env';

import { QUEUE_POLICIES } from '@nexo/contracts';
import { disconnectDatabase, platformPrisma } from '@nexo/database';
import { UnrecoverableError, Worker } from 'bullmq';
import { startHealthServer } from './lib/health-server';
import { logger } from './lib/logger';
import { runProcessor } from './lib/processor';
import { closeRealtime } from './lib/realtime';
import { createRedisConnection } from './lib/redis';
import { checkStorage } from './lib/storage';
import { processors } from './processors';
import { closeEmailTransport } from './processors/email.processor';

/** Tiempo máximo para terminar los trabajos en curso al apagar. */
const SHUTDOWN_TIMEOUT_MS = 30_000;

async function main(): Promise<void> {
  logger.info({ env: env.NODE_ENV }, 'Arrancando worker');

  // --- Base de datos ---------------------------------------------------------
  try {
    await platformPrisma.$connect();
    logger.info('Conectado a PostgreSQL');
  } catch (error) {
    const message = error instanceof Error ? error.message.split('\n')[0] : String(error);
    if (env.NODE_ENV === 'production')
      throw new Error(`No se pudo conectar a PostgreSQL: ${message}`);
    logger.warn(
      `No se pudo conectar a PostgreSQL (${message}). Los trabajos que la usen fallarán y se reintentarán.`,
    );
  }

  // --- Almacenamiento ---------------------------------------------------------
  await checkStorage();

  // --- Colas -----------------------------------------------------------------
  const connection = createRedisConnection();

  const workers = processors.map((definition) => {
    const policy = QUEUE_POLICIES[definition.queue];

    const worker = new Worker(definition.queue, (job) => runProcessor(definition, job), {
      connection,
      concurrency: Math.min(policy.concurrency, env.WORKER_CONCURRENCY),
      // Retención por defecto para los trabajos que no la traigan de la API.
      removeOnComplete: { age: policy.keepCompleted.hours * 3600, count: policy.keepCompleted.max },
      removeOnFail: { age: policy.keepFailed.days * 86_400 },
    });

    worker.on('failed', (job, error) => {
      const attempts = job?.opts.attempts ?? 1;
      // Definitivo si se agotaron los intentos O si el error es irrecuperable
      // (carga inválida): BullMQ no reintenta esos, aunque queden intentos.
      const unrecoverable = error instanceof UnrecoverableError;
      const exhausted = !job || unrecoverable || job.attemptsMade >= attempts;
      logger[exhausted ? 'error' : 'warn'](
        {
          queue: definition.queue,
          jobId: job?.id,
          attempt: job?.attemptsMade,
          of: attempts,
          err: error.message,
        },
        exhausted
          ? 'Trabajo fallido definitivamente: queda en la cola de fallidos para revisión'
          : 'Trabajo fallido; se reintentará',
      );
    });

    // Un error del propio Worker (no de un trabajo): conexión, script de Lua…
    worker.on('error', (error) => {
      logger.error({ queue: definition.queue, err: error.message }, 'Error del consumidor de cola');
    });

    return worker;
  });

  const health = startHealthServer(env.WORKER_HEALTH_PORT, connection, workers);

  logger.info(
    { queues: workers.map((w) => w.name) },
    `Worker listo · ${workers.length} cola(s): ${workers.map((w) => w.name).join(', ')}`,
  );

  // --- Cierre ordenado -------------------------------------------------------
  // Al recibir SIGTERM (docker stop, despliegue) se deja de aceptar trabajos
  // nuevos y se ESPERA a que terminen los que están en curso. Cortar a mitad
  // un envío de correo o una escritura dejaría el trabajo en un estado que
  // obligaría a reprocesarlo.
  let shuttingDown = false;

  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'Apagando: esperando a que terminen los trabajos en curso');

    const force = setTimeout(() => {
      logger.error(`Los trabajos no terminaron en ${SHUTDOWN_TIMEOUT_MS / 1000} s; cierre forzado`);
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    force.unref();

    health.close();
    await Promise.allSettled(workers.map((w) => w.close()));
    closeEmailTransport();
    await closeRealtime();
    await disconnectDatabase();
    await connection.quit().catch(() => connection.disconnect());

    logger.info('Worker detenido');
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

process.on('unhandledRejection', (reason) => {
  logger.fatal(
    { err: reason instanceof Error ? reason.stack : String(reason) },
    'Promesa rechazada sin capturar',
  );
  process.exit(1);
});

main().catch((error: unknown) => {
  logger.fatal(
    { err: error instanceof Error ? error.stack : String(error) },
    'El worker no pudo arrancar',
  );
  process.exit(1);
});
