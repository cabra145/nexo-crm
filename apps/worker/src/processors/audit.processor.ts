import { type ACTOR_TYPES, type AUDIT_ACTIONS, auditJobSchema, QUEUE_NAMES } from '@nexo/contracts';
import { type ActorType, type AuditAction, type Prisma, prisma } from '@nexo/database';
import { defineProcessor } from '../lib/processor';

/* --------------------------------------------------------------------------
 *  Los enums de @nexo/contracts son un espejo escrito a mano de los de
 *  Prisma. Estas dos líneas hacen que divergir sea un error de COMPILACIÓN:
 *  si alguien añade una acción al schema.prisma y no al contrato (o al
 *  revés), el worker no compila y el fallo no llega a producción.
 * ------------------------------------------------------------------------ */
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

const auditActionsMatchPrisma: Same<(typeof AUDIT_ACTIONS)[number], AuditAction> = true;
const actorTypesMatchPrisma: Same<(typeof ACTOR_TYPES)[number], ActorType> = true;
void auditActionsMatchPrisma;
void actorTypesMatchPrisma;

export const auditProcessor = defineProcessor({
  queue: QUEUE_NAMES.AUDIT,
  schema: auditJobSchema,
  // Siempre hay empresa: la entrada se escribe con RLS activa, exactamente
  // igual que cualquier otro dato de negocio.
  tenantOf: (data) => data.tenantId,

  async handle(data, { log }) {
    // INSERT … ON CONFLICT (id) DO NOTHING. El id lo fija quien emite el
    // evento, así que un reintento del mismo trabajo (un intento anterior que
    // escribió la fila pero no llegó a confirmarse en BullMQ) no inserta nada:
    // cero filas = ya estaba registrada. Sin capturar P2002, y sin un error de
    // clave duplicada en los registros de Postgres y de Prisma por cada
    // reintento, que es lo normal y no un fallo.
    const { count } = await prisma.auditLog.createMany({
      skipDuplicates: true,
      data: {
        id: data.id,
        tenantId: data.tenantId,
        actorUserId: data.actorUserId,
        actorEmail: data.actorEmail,
        actorType: data.actorType,
        action: data.action,
        resourceType: data.resourceType,
        resourceId: data.resourceId,
        resourceLabel: data.resourceLabel,
        changes: data.changes as Prisma.InputJsonValue | undefined,
        ip: data.ip,
        userAgent: data.userAgent,
        traceId: data.traceId,
        createdAt: data.occurredAt,
      },
    });

    if (count === 0) {
      log.debug({ auditId: data.id }, 'Entrada de auditoría ya registrada; reintento ignorado');
      return { duplicate: true };
    }

    log.debug({ action: data.action, resourceType: data.resourceType }, 'Auditoría registrada');
    return { duplicate: false };
  },
});
