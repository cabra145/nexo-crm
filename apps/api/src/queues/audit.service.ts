import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { type AuditJob, auditJobSchema } from '@nexo/contracts';
import { Queue } from 'bullmq';
import { AUDIT_QUEUE } from './queue-tokens';

export type AuditEvent = Omit<AuditJob, 'id' | 'occurredAt' | 'actorType'> &
  Partial<Pick<AuditJob, 'occurredAt' | 'actorType'>>;

/**
 * Registro de auditoría: se ENCOLA y lo escribe el worker, para no añadir
 * latencia a la petición que se audita.
 *
 * Que la auditoría no se pueda encolar (Redis caído) NO hace fallar la acción
 * del usuario, pero sí queda en el log con nivel de error: se pierde
 * trazabilidad, y eso tiene que verse.
 */
@Injectable()
export class AuditService {
  private readonly logger = new Logger('Auditoría');

  constructor(@Inject(AUDIT_QUEUE) private readonly queue: Queue) {}

  async record(event: AuditEvent): Promise<void> {
    const job = auditJobSchema.parse({
      ...event,
      id: randomUUID(),
      actorType: event.actorType ?? 'USER',
      occurredAt: event.occurredAt ?? new Date(),
    });
    try {
      // jobId = id de la entrada: si esta misma llamada se reintentara, BullMQ
      // no crearía un segundo trabajo.
      await this.queue.add(job.action, job, { jobId: job.id });
    } catch (error) {
      this.logger.error(
        `No se pudo encolar la auditoría ${job.action} de ${job.resourceType}: ${(error as Error).message}`,
      );
    }
  }

  /** Mismo evento en varias empresas (p. ej. cambio de contraseña de un usuario de varias). */
  async recordForTenants(tenantIds: string[], event: Omit<AuditEvent, 'tenantId'>): Promise<void> {
    await Promise.all(tenantIds.map((tenantId) => this.record({ ...event, tenantId })));
  }
}
