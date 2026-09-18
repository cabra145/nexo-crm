import { HttpStatus, Injectable } from '@nestjs/common';
import {
  type ListTasksQuery,
  type Paginated,
  paginate,
  PROBLEM_TYPES,
  type TaskBucket,
  type TaskCreateInput,
  type TaskUpdateInput,
  type TaskView,
} from '@nexo/contracts';
import { Prisma, runInTenantTransaction, type TenantTransactionClient } from '@nexo/database';
import type { Request } from 'express';
import { ProblemException } from '../common/problem.exception';
import { traceIdOf } from '../common/trace-id';
import { AuditService } from '../queues/audit.service';
import type { ResolvedAccess } from '../team/access.service';
import { AccessService } from '../team/access.service';
import { notFound } from '../team/team.problems';

const taskSelect = {
  id: true,
  title: true,
  description: true,
  status: true,
  priority: true,
  dueAt: true,
  completedAt: true,
  assigneeId: true,
  createdAt: true,
  assignee: { select: { id: true, name: true } },
  contact: { select: { id: true, fullName: true } },
} satisfies Prisma.TaskSelect;

type TaskRow = Prisma.TaskGetPayload<{ select: typeof taskSelect }>;

/** Estados que siguen pendientes de hacer. */
const OPEN: Prisma.TaskWhereInput = { status: { in: ['PENDING', 'IN_PROGRESS'] } };

/**
 * Tareas de la agenda.
 *
 * El alcance del rol se aplica sobre `assigneeId`: un agente ve las suyas, un
 * responsable las de su equipo, un administrador todas. Una tarea sin
 * responsable sólo la ve quien tiene alcance de empresa, igual que un contacto
 * sin dueño.
 *
 * «Hoy» depende de dónde esté quien mira, así que el navegador manda su
 * desfase horario y los tramos se calculan con él. Con el servidor en UTC y el
 * usuario en Quito, una tarea de las 23:00 locales no puede aparecer como «de
 * mañana».
 */
@Injectable()
export class TasksService {
  constructor(
    private readonly accessService: AccessService,
    private readonly audit: AuditService,
  ) {}

  async list(access: ResolvedAccess, query: ListTasksQuery): Promise<Paginated<TaskView>> {
    const scope = await this.accessService.rowFilter(access, 'task:read', 'assigneeId');
    const where: Prisma.TaskWhereInput = {
      deletedAt: null,
      ...(scope as Prisma.TaskWhereInput | null),
      ...(query.mine ? { assigneeId: access.userId } : {}),
      ...(query.assigneeId ? { assigneeId: query.assigneeId } : {}),
      ...(query.contactId ? { contactId: query.contactId } : {}),
      ...bucketFilter(query.bucket, query.tzOffset),
    };

    const done = query.bucket === 'done';
    const rows = await runInTenantTransaction((tx) =>
      tx.task.findMany({
        where,
        select: taskSelect,
        // Lo pendiente, por lo que vence antes; lo hecho, por lo más reciente.
        orderBy: done ? [{ id: 'desc' }] : [{ dueAt: 'asc' }, { id: 'asc' }],
        take: query.limit + 1,
        ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      }),
    );
    const page = paginate(rows, query.limit);
    return { ...page, data: page.data.map(toView) };
  }

  async create(access: ResolvedAccess, input: TaskCreateInput, req: Request): Promise<TaskView> {
    const row = await runInTenantTransaction(async (tx) => {
      await this.assertAssignee(tx, input.assigneeId);
      const contact = await this.contactInScope(tx, access, input.contactId);

      const created = await tx.task.create({
        data: {
          tenantId: access.tenantId,
          title: input.title,
          description: input.description ?? null,
          dueAt: input.dueAt ?? null,
          priority: input.priority,
          // Sin responsable indicado, la tarea es de quien la crea.
          assigneeId: input.assigneeId === undefined ? access.userId : input.assigneeId,
          contactId: contact?.id ?? null,
          creatorId: access.userId,
        },
        select: taskSelect,
      });

      if (contact) {
        await tx.activity.create({
          data: {
            tenantId: access.tenantId,
            type: 'TASK',
            subjectType: 'Task',
            subjectId: created.id,
            contactId: contact.id,
            actorId: access.userId,
            title: `Tarea creada: ${created.title}`,
          },
        });
      }
      return created;
    });

    await this.record(access, req, 'CREATE', row, {});
    return toView(row);
  }

  async update(
    access: ResolvedAccess,
    id: string,
    input: TaskUpdateInput,
    req: Request,
  ): Promise<TaskView> {
    const { row, changes } = await runInTenantTransaction(async (tx) => {
      const before = await this.findInScope(tx, access, id);
      await this.assertAssignee(tx, input.assigneeId);
      const contact =
        input.contactId === undefined
          ? undefined
          : await this.contactInScope(tx, access, input.contactId);

      const completing = input.status === 'DONE' && before.status !== 'DONE';
      const reopening =
        input.status !== undefined && input.status !== 'DONE' && before.status === 'DONE';

      const after = await tx.task.update({
        where: { id },
        data: {
          ...(input.title !== undefined ? { title: input.title } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.dueAt !== undefined ? { dueAt: input.dueAt } : {}),
          ...(input.priority !== undefined ? { priority: input.priority } : {}),
          ...(input.assigneeId !== undefined ? { assigneeId: input.assigneeId } : {}),
          ...(input.contactId !== undefined ? { contactId: contact?.id ?? null } : {}),
          ...(input.status !== undefined ? { status: input.status } : {}),
          // La fecha de cierre la pone el servidor, no el cliente.
          ...(completing ? { completedAt: new Date() } : {}),
          ...(reopening ? { completedAt: null } : {}),
        },
        select: taskSelect,
      });

      if (completing && after.contact) {
        await tx.activity.create({
          data: {
            tenantId: access.tenantId,
            type: 'TASK',
            subjectType: 'Task',
            subjectId: after.id,
            contactId: after.contact.id,
            actorId: access.userId,
            title: `Tarea completada: ${after.title}`,
          },
        });
      }

      const diff: Record<string, { antes: unknown; despues: unknown }> = {};
      for (const field of ['title', 'status', 'priority', 'assigneeId'] as const) {
        if (before[field] !== after[field]) {
          diff[field] = { antes: before[field], despues: after[field] };
        }
      }
      if (before.dueAt?.getTime() !== after.dueAt?.getTime()) {
        diff.dueAt = { antes: before.dueAt, despues: after.dueAt };
      }
      return { row: after, changes: diff };
    });

    if (Object.keys(changes).length > 0) await this.record(access, req, 'UPDATE', row, changes);
    return toView(row);
  }

  async remove(access: ResolvedAccess, id: string, req: Request): Promise<void> {
    const row = await runInTenantTransaction(async (tx) => {
      const current = await this.findInScope(tx, access, id);
      await tx.task.update({ where: { id }, data: { deletedAt: new Date() } });
      return current;
    });
    await this.record(access, req, 'DELETE', row, {});
  }

  /* ------------------------------------------------------------------------ */

  private async findInScope(
    tx: TenantTransactionClient,
    access: ResolvedAccess,
    id: string,
  ): Promise<TaskRow> {
    const scope = await this.accessService.rowFilter(access, 'task:write', 'assigneeId');
    const row = await tx.task.findFirst({
      where: { id, deletedAt: null, ...(scope as Prisma.TaskWhereInput | null) },
      select: taskSelect,
    });
    if (!row) throw notFound('Tarea');
    return row;
  }

  /** El contacto tiene que existir y estar dentro del alcance de quien actúa. */
  private async contactInScope(
    tx: TenantTransactionClient,
    access: ResolvedAccess,
    contactId: string | null | undefined,
  ): Promise<{ id: string } | null> {
    if (!contactId) return null;
    const scope = await this.accessService.rowFilter(access, 'contact:read');
    const contact = await tx.contact.findFirst({
      where: { id: contactId, deletedAt: null, ...(scope as Prisma.ContactWhereInput | null) },
      select: { id: true },
    });
    if (!contact) {
      throw new ProblemException({
        type: PROBLEM_TYPES.VALIDATION,
        title: 'El contacto no existe',
        status: HttpStatus.BAD_REQUEST,
        errors: [{ field: 'contactId', message: 'no existe o no tienes acceso' }],
      });
    }
    return contact;
  }

  /** Sólo se puede asignar trabajo a un miembro activo de la empresa. */
  private async assertAssignee(
    tx: TenantTransactionClient,
    assigneeId: string | null | undefined,
  ): Promise<void> {
    if (!assigneeId) return;
    const member = await tx.membership.findFirst({
      where: { userId: assigneeId, status: 'ACTIVE' },
      select: { id: true },
    });
    if (!member) {
      throw new ProblemException({
        type: PROBLEM_TYPES.VALIDATION,
        title: 'Esa persona no está en el equipo',
        status: HttpStatus.BAD_REQUEST,
        errors: [{ field: 'assigneeId', message: 'no es un miembro activo' }],
      });
    }
  }

  private record(
    access: ResolvedAccess,
    req: Request,
    action: 'CREATE' | 'UPDATE' | 'DELETE',
    row: TaskRow,
    changes: Record<string, unknown>,
  ): Promise<void> {
    return this.audit.record({
      tenantId: access.tenantId,
      actorUserId: access.userId,
      action,
      resourceType: 'Task',
      resourceId: row.id,
      resourceLabel: row.title,
      changes,
      ip: req.ip,
      userAgent: req.headers['user-agent']?.slice(0, 500),
      traceId: traceIdOf(req),
    });
  }
}

/* ========================================================================== */

/**
 * Tramo del día en el que cae una tarea, calculado en la zona de quien mira.
 *
 * `tzOffset` es lo que devuelve `Date.getTimezoneOffset()`: minutos que hay
 * que SUMAR a la hora local para obtener UTC (Quito → 300).
 */
function bucketFilter(bucket: TaskBucket | undefined, tzOffset: number): Prisma.TaskWhereInput {
  if (!bucket) return {};
  if (bucket === 'done') return { status: { in: ['DONE', 'CANCELLED'] } };

  const offsetMs = tzOffset * 60_000;
  const localNow = new Date(Date.now() - offsetMs);
  const startOfLocalDay = Date.UTC(
    localNow.getUTCFullYear(),
    localNow.getUTCMonth(),
    localNow.getUTCDate(),
  );
  const dayStart = new Date(startOfLocalDay + offsetMs);
  const dayEnd = new Date(startOfLocalDay + 86_400_000 + offsetMs);

  switch (bucket) {
    case 'overdue':
      return { ...OPEN, dueAt: { lt: dayStart } };
    case 'today':
      return { ...OPEN, dueAt: { gte: dayStart, lt: dayEnd } };
    case 'upcoming':
      return { ...OPEN, dueAt: { gte: dayEnd } };
    case 'someday':
      return { ...OPEN, dueAt: null };
  }
}

function toView(row: TaskRow): TaskView {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    status: row.status,
    priority: row.priority,
    dueAt: row.dueAt?.toISOString() ?? null,
    completedAt: row.completedAt?.toISOString() ?? null,
    assignee: row.assignee,
    contact: row.contact,
    createdAt: row.createdAt.toISOString(),
  };
}
