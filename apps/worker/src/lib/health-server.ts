import { createServer, type Server } from 'node:http';
import type { Worker } from 'bullmq';
import type Redis from 'ioredis';
import { logger } from './logger';

/**
 * Sonda de salud del worker: GET http://127.0.0.1:<puerto>/health
 *
 * Un worker no atiende peticiones, así que sin esto no hay forma de saber
 * desde fuera si está procesando o se quedó colgado. Devuelve 503 si Redis no
 * está conectado o si alguna cola dejó de consumir.
 *
 * Escucha SÓLO en 127.0.0.1: la consulta el healthcheck de Docker desde dentro
 * del contenedor, y no hay motivo para exponerla a la red.
 */
export function startHealthServer(port: number, redis: Redis, workers: Worker[]): Server {
  const startedAt = Date.now();

  const server = createServer((req, res) => {
    if (req.method !== 'GET' || req.url !== '/health') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 404, title: 'No encontrado' }));
      return;
    }

    const queues = workers.map((w) => ({
      queue: w.name,
      running: w.isRunning(),
      paused: w.isPaused(),
    }));
    const redisReady = redis.status === 'ready';
    const healthy = redisReady && queues.every((q) => q.running && !q.paused);

    res.writeHead(healthy ? 200 : 503, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        status: healthy ? 'ok' : 'degraded',
        service: 'nexo-worker',
        uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
        redis: redis.status,
        queues,
      }),
    );
  });

  server.on('error', (error: NodeJS.ErrnoException) => {
    const hint =
      error.code === 'EADDRINUSE'
        ? ` El puerto ${port} está ocupado; cambia WORKER_HEALTH_PORT en .env.`
        : '';
    logger.error({ err: error.message }, `No se pudo abrir la sonda de salud.${hint}`);
  });

  server.listen(port, '127.0.0.1', () => {
    logger.info(`Sonda de salud en http://127.0.0.1:${port}/health`);
  });

  return server;
}
