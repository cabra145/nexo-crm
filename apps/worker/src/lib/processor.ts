import type { QueueName } from '@nexo/contracts';
import { runWithTenantContext } from '@nexo/database';
import { type Job, UnrecoverableError } from 'bullmq';
import type { z, ZodTypeAny } from 'zod';
import { logger, type Logger } from './logger';

/**
 * Definición de un procesador de cola.
 *
 * Cada procesador declara su esquema y su lógica; todo lo demás —validar la
 * carga, fijar el contexto de empresa, registrar— lo hace `runProcessor` igual
 * para todos. Así un procesador nuevo no puede olvidarse de ninguna de esas
 * tres cosas.
 */
export interface ProcessorDefinition<S extends ZodTypeAny = ZodTypeAny> {
  queue: QueueName;
  schema: S;
  /**
   * De qué empresa es el trabajo. Si devuelve un id, el procesador corre dentro
   * de `runWithTenantContext`, y todas sus consultas quedan aisladas por la
   * extensión de Prisma y por RLS exactamente igual que en una petición HTTP.
   */
  tenantOf?: (data: z.infer<S>) => string | undefined;
  handle: (data: z.infer<S>, ctx: { job: Job; log: Logger }) => Promise<unknown>;
}

/**
 * Un procesador cualquiera, con el tipo de su carga borrado. Es la forma en que
 * se guardan juntos en el registro.
 *
 * Existe porque `ProcessorDefinition<S>` no sirve para eso: `S` aparece a la
 * vez como valor que se entrega (`schema`) y como parámetro que se recibe
 * (`handle(data)`), así que TypeScript lo trata como INVARIANTE y rechaza meter
 * un `ProcessorDefinition<EsquemaDeEmail>` en una lista de
 * `ProcessorDefinition<ZodTypeAny>`, aunque la carga sea `any`. Una interfaz
 * sin parámetro de tipo se compara por su forma, y ahí sí encaja.
 *
 * El tipo exacto no se pierde donde importa: dentro de cada procesador,
 * `handle` sigue recibiendo su carga tipada (`EmailJob`, `AuditJob`).
 */
export interface AnyProcessorDefinition {
  queue: QueueName;
  schema: ZodTypeAny;
  // `any` y no `unknown`, a propósito: con `unknown` en un parámetro,
  // `(data: EmailJob) => …` NO sería asignable (los parámetros se comparan al
  // revés), y volveríamos al error de compilación del paso 15. Es el único
  // punto del worker donde se borra el tipo, y `runProcessor` valida la carga
  // con zod antes de pasarla.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tenantOf?: (data: any) => string | undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handle: (data: any, ctx: { job: Job; log: Logger }) => Promise<unknown>;
}

export function defineProcessor<S extends ZodTypeAny>(
  definition: ProcessorDefinition<S>,
): ProcessorDefinition<S> {
  return definition;
}

/** Ejecuta un trabajo aplicando validación, contexto de empresa y registro. */
export async function runProcessor(definition: AnyProcessorDefinition, job: Job): Promise<unknown> {
  const parsed = definition.schema.safeParse(job.data);

  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join('.') || '(raíz)'}: ${i.message}`)
      .join('; ');
    // UnrecoverableError → BullMQ lo marca fallido SIN reintentos. Reintentar
    // una carga inválida da exactamente el mismo resultado seis veces.
    throw new UnrecoverableError(`Carga del trabajo inválida — ${issues}`);
  }

  const data: unknown = parsed.data;
  const traceId =
    typeof (data as { traceId?: unknown }).traceId === 'string'
      ? (data as { traceId: string }).traceId
      : undefined;

  const log = logger.child({
    queue: definition.queue,
    jobId: job.id,
    attempt: job.attemptsMade + 1,
    ...(traceId ? { traceId } : {}),
  });

  const tenantId = definition.tenantOf?.(data);
  const run = () => definition.handle(data, { job, log });

  if (!tenantId) return run();

  return runWithTenantContext(
    { tenantId, actorType: 'SYSTEM', ...(traceId ? { traceId } : {}) },
    run,
  );
}
