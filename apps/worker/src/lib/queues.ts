import { QUEUE_NAMES, QUEUE_POLICIES, type WhatsappMediaJob } from '@nexo/contracts';
import { Queue } from 'bullmq';
import { env } from '../bootstrap/env';

let mediaQueue: Queue | null = null;

/**
 * Colas en las que el WORKER encola (hasta ahora sólo consumía).
 *
 * Conexión propia y perezosa, con opciones y no con un cliente prestado: así
 * `close()` la cierra y no mantiene vivo el proceso al apagar (el mismo motivo
 * que en la API, queues.module.ts). Límite de reintentos y sin cola sin
 * conexión: si Redis no responde, encolar FALLA en el acto, y el trabajo que
 * encolaba se reintenta entero (ver whatsapp-inbound).
 */
function media(): Queue {
  if (!mediaQueue) {
    const policy = QUEUE_POLICIES[QUEUE_NAMES.WHATSAPP_MEDIA];
    const url = new URL(env.REDIS_URL);
    mediaQueue = new Queue(QUEUE_NAMES.WHATSAPP_MEDIA, {
      connection: {
        host: url.hostname,
        port: Number(url.port || 6379),
        password: url.password ? decodeURIComponent(url.password) : undefined,
        db: url.pathname.length > 1 ? Number(url.pathname.slice(1)) : undefined,
        maxRetriesPerRequest: 2,
        enableOfflineQueue: false,
        connectionName: `nexo-worker:${QUEUE_NAMES.WHATSAPP_MEDIA}`,
      },
      defaultJobOptions: {
        attempts: policy.attempts,
        backoff: { type: 'exponential', delay: policy.backoffMs },
        removeOnComplete: {
          age: policy.keepCompleted.hours * 3600,
          count: policy.keepCompleted.max,
        },
        removeOnFail: { age: policy.keepFailed.days * 86_400 },
      },
    });
  }
  return mediaQueue;
}

/**
 * Encola la descarga de archivos. El id del trabajo es el de la fila: encolar
 * dos veces el mismo archivo (reintento, webhook repetido) no lo descarga dos
 * veces.
 */
export async function enqueueMediaDownloads(tenantId: string, mediaIds: string[]): Promise<void> {
  if (mediaIds.length === 0) return;
  const queue = media();
  await queue.waitUntilReady();
  await queue.addBulk(
    mediaIds.map((mediaId) => ({
      name: QUEUE_NAMES.WHATSAPP_MEDIA,
      data: { mediaId, tenantId } satisfies WhatsappMediaJob,
      opts: { jobId: mediaId },
    })),
  );
}

export async function closeQueues(): Promise<void> {
  await mediaQueue?.close();
  mediaQueue = null;
}
