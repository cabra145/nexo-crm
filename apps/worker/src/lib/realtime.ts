import { realtimeChannel, type RealtimeEvent } from '@nexo/contracts';
import Redis from 'ioredis';
import { env } from '../bootstrap/env';
import { logger } from './logger';

let publisher: Redis | null = null;

/**
 * Publica avisos en tiempo real para la bandeja (ver contracts/realtime.ts).
 *
 * Conexión propia y perezosa, con límite de reintentos: la de BullMQ no lo
 * tiene a propósito (espera indefinidamente), y un aviso NO debe bloquear el
 * trabajo que ya guardó sus cambios. Si Redis no responde, el aviso se pierde
 * y la pantalla se pone al día en la siguiente recarga o reconexión.
 */
export async function publishRealtime(tenantId: string, events: RealtimeEvent[]): Promise<void> {
  if (events.length === 0) return;
  if (!publisher) {
    publisher = new Redis(env.REDIS_URL, {
      maxRetriesPerRequest: 2,
      connectionName: 'nexo-worker-realtime',
      retryStrategy: (attempt) => Math.min(attempt * 250, 5_000),
    });
    // Los fallos se registran al publicar; aquí sólo se evita el error sin manejar.
    publisher.on('error', () => undefined);
  }
  try {
    const channel = realtimeChannel(tenantId);
    await Promise.all(events.map((event) => publisher!.publish(channel, JSON.stringify(event))));
  } catch (error) {
    logger.warn({ err: (error as Error).message }, 'No se pudo publicar un aviso en tiempo real');
  }
}

export async function closeRealtime(): Promise<void> {
  if (!publisher) return;
  await publisher.quit().catch(() => publisher?.disconnect());
  publisher = null;
}
