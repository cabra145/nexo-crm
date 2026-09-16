/**
 * Prueba de humo del worker, de principio a fin.
 *
 * Encola trabajos REALES en Redis y comprueba que el worker en marcha los
 * procesa y que el efecto llega a su destino:
 *
 *   correo     → Redis → worker → SMTP → Mailpit
 *   auditoría  → Redis → worker → Postgres (con RLS)
 *
 * Además verifica tres garantías que no se ven en el camino feliz:
 *
 *   · una carga inválida se descarta SIN reintentos
 *   · reprocesar la misma auditoría no la duplica (idempotencia)
 *   · la entrada escrita por el worker queda aislada: otra empresa no la ve
 *
 * Requisitos: Docker levantado, base migrada con seed, y el worker corriendo
 * (`pnpm --filter @nexo/worker dev`) en otra terminal.
 *
 *   pnpm --filter @nexo/worker smoke
 *
 * Deja la base como estaba: borra las entradas de auditoría que crea.
 */
import '../src/bootstrap/env';

import { randomUUID } from 'node:crypto';
import {
  type AuditJob,
  type EmailJob,
  QUEUE_NAMES,
  QUEUE_POLICIES,
  type QueueName,
} from '@nexo/contracts';
import { PrismaClient, disconnectDatabase, prisma, runWithTenantContext } from '@nexo/database';
import { type Job, Queue, QueueEvents } from 'bullmq';
import Redis from 'ioredis';
import { env } from '../src/bootstrap/env';

const MAILPIT_URL = process.env.MAILPIT_URL ?? 'http://localhost:8025';
const JOB_TIMEOUT_MS = 20_000;

/* -------------------------------------------------------------------------- */

const results: Array<{ name: string; passed: boolean }> = [];

function check(name: string, passed: boolean, detail = ''): void {
  results.push({ name, passed });
  console.log(`  ${passed ? '✓' : '✗'} ${name}${detail ? `  — ${detail}` : ''}`);
}

function jobOptions(queue: QueueName) {
  const policy = QUEUE_POLICIES[queue];
  return {
    attempts: policy.attempts,
    backoff: { type: 'exponential' as const, delay: policy.backoffMs },
  };
}

/** Espera a que Mailpit reciba un correo con ese asunto. */
async function waitForMail(subject: string, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await fetch(`${MAILPIT_URL}/api/v1/messages?limit=50`);
    if (res.ok) {
      const body = (await res.json()) as {
        messages?: Array<{ ID: string; Subject: string; To: Array<{ Address: string }> }>;
      };
      const found = body.messages?.find((m) => m.Subject === subject);
      if (found) return found;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return null;
}

/* -------------------------------------------------------------------------- */

async function main(): Promise<void> {
  const connection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
  const emailQueue = new Queue(QUEUE_NAMES.EMAIL, { connection });
  const auditQueue = new Queue(QUEUE_NAMES.AUDIT, { connection });
  const emailEvents = new QueueEvents(QUEUE_NAMES.EMAIL, { connection: connection.duplicate() });
  const auditEvents = new QueueEvents(QUEUE_NAMES.AUDIT, { connection: connection.duplicate() });

  // El rol dueño sólo se usa para preparar (averiguar ids) y limpiar.
  const owner = new PrismaClient({
    datasourceUrl: process.env.DIRECT_DATABASE_URL ?? process.env.DATABASE_URL,
  });

  const createdAuditIds: string[] = [];

  try {
    await Promise.all([emailEvents.waitUntilReady(), auditEvents.waitUntilReady()]);

    // ¿Está el worker corriendo? Sin él, cada trabajo esperaría hasta el tiempo
    // límite y los fallos serían confusos. Se pregunta a su propia sonda de
    // salud, que es la fuente fiable de si está consumiendo.
    const healthUrl = `http://127.0.0.1:${env.WORKER_HEALTH_PORT}/health`;
    const health = await fetch(healthUrl).catch(() => null);
    if (!health?.ok) {
      console.error(
        `\nEl worker no responde en ${healthUrl}.\n` +
          'Arráncalo en otra terminal: pnpm --filter @nexo/worker dev\n',
      );
      process.exitCode = 1;
      return;
    }

    const acme = await owner.tenant.findUnique({ where: { slug: 'acme' } });
    const boreal = await owner.tenant.findUnique({ where: { slug: 'boreal' } });
    const actor = await owner.user.findUnique({ where: { email: 'sebastian@acme.test' } });
    if (!acme || !boreal || !actor) {
      console.error('\nFaltan las empresas o usuarios del seed. Ejecuta: pnpm --filter @nexo/database seed\n');
      process.exitCode = 1;
      return;
    }

    const runId = randomUUID().slice(0, 8);
    console.log(`\nPrueba de humo del worker · ejecución ${runId}\n`);

    /* ---------------------------------------------------------------------- */
    console.log('1 · Correo: Redis → worker → SMTP → Mailpit');

    const subject = `Prueba de humo ${runId}`;
    const emailJob: EmailJob = {
      to: 'lucia@acme.test',
      subject,
      text: `Si lees esto, el recorrido completo funciona. Ejecución ${runId}.`,
      html: `<p>Si lees esto, el recorrido completo <strong>funciona</strong>. Ejecución ${runId}.</p>`,
      category: 'system',
      tenantId: acme.id,
      traceId: `smoke-${runId}`,
    };

    const sent: Job = await emailQueue.add('smoke', emailJob, jobOptions(QUEUE_NAMES.EMAIL));
    try {
      const out = (await sent.waitUntilFinished(emailEvents, JOB_TIMEOUT_MS)) as {
        messageId?: string;
      };
      check('el worker procesó el trabajo de correo', true, `messageId ${out?.messageId ?? '?'}`);
    } catch (error) {
      check('el worker procesó el trabajo de correo', false, (error as Error).message);
    }

    const mail = await waitForMail(subject);
    check('el correo llegó a Mailpit', mail !== null, mail ? `abre ${MAILPIT_URL}` : 'no apareció en 10 s');
    check(
      'con el destinatario correcto',
      mail?.To?.some((t) => t.Address === 'lucia@acme.test') ?? false,
    );

    /* ---------------------------------------------------------------------- */
    console.log('\n2 · Una carga inválida se descarta sin reintentos');

    const invalid = await emailQueue.add(
      'smoke-invalido',
      { to: 'esto-no-es-un-correo', subject: '', text: '', category: 'desconocida' },
      jobOptions(QUEUE_NAMES.EMAIL), // 6 intentos permitidos…
    );
    try {
      await invalid.waitUntilFinished(emailEvents, JOB_TIMEOUT_MS);
      check('el trabajo inválido fue rechazado', false, 'se procesó como válido');
    } catch {
      const state = await invalid.getState();
      const fresh = await emailQueue.getJob(invalid.id!);
      check('el trabajo inválido fue rechazado', state === 'failed', `estado: ${state}`);
      check(
        '…en el primer intento, sin reintentos',
        fresh?.attemptsMade === 1,
        `intentos: ${fresh?.attemptsMade} de 6 permitidos`,
      );
      check(
        '…con el motivo explicado',
        fresh?.failedReason?.startsWith('Carga del trabajo inválida') ?? false,
        fresh?.failedReason?.slice(0, 80),
      );
      await fresh?.remove();
    }

    /* ---------------------------------------------------------------------- */
    console.log('\n3 · Auditoría: Redis → worker → Postgres con RLS');

    const auditId = randomUUID();
    createdAuditIds.push(auditId);
    const auditJob: AuditJob = {
      id: auditId,
      tenantId: acme.id,
      actorUserId: actor.id,
      actorEmail: actor.email,
      actorType: 'USER',
      action: 'SEND',
      resourceType: 'SmokeTest',
      resourceLabel: `Prueba de humo ${runId}`,
      changes: { ejecucion: { antes: null, despues: runId } },
      ip: '127.0.0.1',
      traceId: `smoke-${runId}`,
      occurredAt: new Date(),
    };

    const audited = await auditQueue.add('smoke', auditJob, jobOptions(QUEUE_NAMES.AUDIT));
    try {
      const out = (await audited.waitUntilFinished(auditEvents, JOB_TIMEOUT_MS)) as {
        duplicate?: boolean;
      };
      check('el worker procesó el trabajo de auditoría', true, `duplicado: ${out?.duplicate}`);
    } catch (error) {
      check('el worker procesó el trabajo de auditoría', false, (error as Error).message);
    }

    const row = await owner.auditLog.findUnique({ where: { id: auditId } });
    check('la entrada existe en audit_log', row !== null);
    check('pertenece a Acme', row?.tenantId === acme.id);
    check('conserva el trace_id de origen', row?.traceId === `smoke-${runId}`);

    /* ---------------------------------------------------------------------- */
    console.log('\n4 · Reprocesar la misma auditoría no la duplica');

    const again = await auditQueue.add('smoke-repetido', auditJob, jobOptions(QUEUE_NAMES.AUDIT));
    try {
      const out = (await again.waitUntilFinished(auditEvents, JOB_TIMEOUT_MS)) as {
        duplicate?: boolean;
      };
      check('el reintento termina bien, marcado como duplicado', out?.duplicate === true);
    } catch (error) {
      check('el reintento termina bien, marcado como duplicado', false, (error as Error).message);
    }
    const copies = await owner.auditLog.count({ where: { id: auditId } });
    check('sigue habiendo una sola entrada', copies === 1, `${copies} entrada(s)`);

    /* ---------------------------------------------------------------------- */
    console.log('\n5 · Lo que escribe el worker queda aislado por empresa');

    const seenByAcme = await runWithTenantContext({ tenantId: acme.id }, () =>
      prisma.auditLog.findUnique({ where: { id: auditId } }),
    );
    check('Acme ve su entrada, con el rol de aplicación', seenByAcme !== null);

    const seenByBoreal = await runWithTenantContext({ tenantId: boreal.id }, () =>
      prisma.auditLog.findUnique({ where: { id: auditId } }),
    );
    check('Boreal NO la ve', seenByBoreal === null);
  } finally {
    // Limpieza: la prueba no deja rastro en la base.
    if (createdAuditIds.length) {
      await owner.auditLog.deleteMany({ where: { id: { in: createdAuditIds } } }).catch(() => {});
    }
    await owner.$disconnect();
    await disconnectDatabase().catch(() => {});
    await Promise.allSettled([
      emailEvents.close(),
      auditEvents.close(),
      emailQueue.close(),
      auditQueue.close(),
    ]);
    await connection.quit().catch(() => connection.disconnect());
  }

  const failed = results.filter((r) => !r.passed);
  if (results.length === 0) return;

  console.log(
    `\n${results.length - failed.length}/${results.length} comprobaciones superadas` +
      (failed.length ? ` — ${failed.length} FALLIDA(S)` : ''),
  );
  if (failed.length) {
    process.exitCode = 1;
  } else {
    console.log('Worker verificado de principio a fin.\n');
  }
}

main().catch((error: unknown) => {
  console.error('\nLa prueba no pudo completarse:\n', error);
  process.exit(1);
});
