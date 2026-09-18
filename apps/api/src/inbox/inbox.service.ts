import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import {
  type ConversationCounts,
  type ConversationDetail,
  type ConversationList,
  type ConversationListQuery,
  type ConversationSummary,
  INBOX_PROBLEMS,
  type MessageListQuery,
  type MessagePage,
  type MessageView,
  type Permission,
  PROBLEM_TYPES,
  QUEUE_NAMES,
  type RealtimeEvent,
  type WhatsappOutboundJob,
} from '@nexo/contracts';
import { Prisma, runInTenantTransaction, type TenantTransactionClient } from '@nexo/database';
import type { Queue } from 'bullmq';
import type { Request } from 'express';
import { ProblemException } from '../common/problem.exception';
import { traceIdOf } from '../common/trace-id';
import { AuditService } from '../queues/audit.service';
import { WHATSAPP_OUTBOUND_QUEUE } from '../queues/queue-tokens';
import { RealtimeService } from '../realtime/realtime.service';
import { AccessService, type ResolvedAccess } from '../team/access.service';
import { conflict, notFound } from '../team/team.problems';

const summarySelect = {
  id: true,
  status: true,
  assigneeId: true,
  lastMessageAt: true,
  lastMessagePreview: true,
  lastMessageDirection: true,
  unreadCount: true,
  windowExpiresAt: true,
  contact: { select: { id: true, fullName: true, whatsappE164: true, phoneE164: true } },
  channel: { select: { id: true, name: true, displayId: true, status: true } },
  assignee: { select: { id: true, name: true } },
} satisfies Prisma.ConversationSelect;

type SummaryRow = Prisma.ConversationGetPayload<{ select: typeof summarySelect }>;

const OPEN_STATES = ['OPEN', 'PENDING', 'SNOOZED'] as const;

/**
 * Bandeja de entrada.
 *
 * QUÉ conversaciones ve cada uno: las SIN asignar, todo el que puede ver
 * conversaciones (para poder tomarlas); las asignadas, según el alcance de su
 * permiso sobre la persona asignada. El mismo criterio decide quién recibe los
 * avisos en tiempo real (RealtimeService.canSee).
 *
 * Enviar un mensaje lo guarda como QUEUED y lo encola: la petición no espera
 * a Meta. El worker lo envía y actualiza su estado.
 */
@Injectable()
export class InboxService {
  private readonly logger = new Logger('Bandeja');

  constructor(
    private readonly accessService: AccessService,
    private readonly audit: AuditService,
    private readonly realtime: RealtimeService,
    @Inject(WHATSAPP_OUTBOUND_QUEUE) private readonly outbound: Queue,
  ) {}

  /* ======================================================================== */
  /*  Lectura                                                                  */
  /* ======================================================================== */

  async list(access: ResolvedAccess, query: ConversationListQuery): Promise<ConversationList> {
    const visible = await this.visibleWhere(access, 'conversation:read');
    const state: Prisma.ConversationWhereInput =
      query.state === 'resolved' ? { status: 'RESOLVED' } : { status: { in: [...OPEN_STATES] } };
    const views: Record<keyof ConversationCounts, Prisma.ConversationWhereInput> = {
      mine: { assigneeId: access.userId },
      unassigned: { assigneeId: null },
      all: {},
    };
    const search: Prisma.ConversationWhereInput = query.q
      ? {
          contact: {
            OR: [
              { fullName: { contains: query.q, mode: 'insensitive' } },
              { whatsappE164: { contains: query.q.replace(/[^\d+]/g, '') || query.q } },
            ],
          },
        }
      : {};

    return runInTenantTransaction(async (tx) => {
      const rows = await tx.conversation.findMany({
        where: { AND: [visible, state, views[query.view], search] },
        select: summarySelect,
        orderBy: [{ lastMessageAt: { sort: 'desc', nulls: 'last' } }, { id: 'desc' }],
        take: query.limit + 1,
        ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      });

      const [mine, unassigned, all] = await Promise.all(
        (['mine', 'unassigned', 'all'] as const).map((view) =>
          tx.conversation.count({
            where: {
              AND: [visible, { status: { in: [...OPEN_STATES] } }, views[view]],
              unreadCount: { gt: 0 },
            },
          }),
        ),
      );

      const hasMore = rows.length > query.limit;
      const data = (hasMore ? rows.slice(0, query.limit) : rows).map(toSummary);
      return {
        data,
        hasMore,
        nextCursor: hasMore ? (data[data.length - 1]?.id ?? null) : null,
        unread: { mine: mine!, unassigned: unassigned!, all: all! },
      };
    });
  }

  async get(access: ResolvedAccess, id: string): Promise<ConversationDetail> {
    const visible = await this.visibleWhere(access, 'conversation:read');
    const row = await runInTenantTransaction((tx) =>
      tx.conversation.findFirst({ where: { AND: [{ id }, visible] }, select: summarySelect }),
    );
    if (!row) throw notFound('Conversación');
    return this.detail(access, row);
  }

  async messages(
    access: ResolvedAccess,
    id: string,
    query: MessageListQuery,
  ): Promise<MessagePage> {
    const visible = await this.visibleWhere(access, 'conversation:read');
    return runInTenantTransaction(async (tx) => {
      const conversation = await tx.conversation.findFirst({
        where: { AND: [{ id }, visible] },
        select: { id: true },
      });
      if (!conversation) throw notFound('Conversación');

      const rows = await tx.message.findMany({
        where: { conversationId: id, isInternal: false },
        select: {
          id: true,
          direction: true,
          type: true,
          body: true,
          status: true,
          errorMessage: true,
          senderUserId: true,
          createdAt: true,
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: query.limit + 1,
        ...(query.before ? { cursor: { id: query.before }, skip: 1 } : {}),
      });
      const hasMore = rows.length > query.limit;
      const page = (hasMore ? rows.slice(0, query.limit) : rows).reverse();

      const senderIds = [...new Set(page.map((m) => m.senderUserId).filter((v) => v !== null))];
      const senders = senderIds.length
        ? await tx.user.findMany({
            where: { id: { in: senderIds } },
            select: { id: true, name: true },
          })
        : [];
      const byId = new Map(senders.map((u) => [u.id, u]));

      const data: MessageView[] = page.map((m) => ({
        id: m.id,
        direction: m.direction,
        type: m.type,
        body: m.body,
        status: m.status,
        errorMessage: m.errorMessage,
        sender: m.senderUserId ? (byId.get(m.senderUserId) ?? null) : null,
        createdAt: m.createdAt.toISOString(),
      }));
      return { data, hasMore };
    });
  }

  /* ======================================================================== */
  /*  Escritura                                                                */
  /* ======================================================================== */

  /**
   * Responde por WhatsApp. Responder a una conversación sin asignar la toma:
   * quien contesta es quien la lleva, y así dos agentes no contestan a la vez
   * al mismo cliente sin saberlo.
   */
  async send(access: ResolvedAccess, id: string, body: string): Promise<MessageView> {
    const writable = await this.visibleWhere(access, 'conversation:write');
    const now = new Date();

    const { message, event, sender } = await runInTenantTransaction(async (tx) => {
      // Bloquea la fila: dos envíos simultáneos a una conversación sin asignar
      // no la asignan a dos personas.
      await tx.$queryRaw`SELECT id FROM conversation WHERE id = ${id}::uuid FOR UPDATE`;
      const conversation = await tx.conversation.findFirst({
        where: { AND: [{ id }, writable] },
        select: {
          id: true,
          channelId: true,
          assigneeId: true,
          windowExpiresAt: true,
          channel: { select: { status: true, credentialsEncrypted: true } },
        },
      });
      if (!conversation) throw notFound('Conversación');
      assertCanSend(conversation, now);

      const created = await tx.message.create({
        data: {
          tenantId: access.tenantId,
          conversationId: id,
          channelId: conversation.channelId,
          direction: 'OUTBOUND',
          type: 'TEXT',
          body,
          status: 'QUEUED',
          statusUpdatedAt: now,
          senderUserId: access.userId,
          senderType: 'USER',
          createdAt: now,
        },
        select: { id: true, createdAt: true },
      });

      const takes = conversation.assigneeId === null;
      await tx.conversation.update({
        where: { id },
        data: {
          lastMessageAt: now,
          lastMessagePreview: body.length > 200 ? `${body.slice(0, 197)}…` : body,
          lastMessageDirection: 'OUTBOUND',
          // Quien responde ya leyó lo anterior.
          unreadCount: 0,
          status: 'OPEN',
          resolvedAt: null,
          ...(takes ? { assigneeId: access.userId } : {}),
        },
      });

      const event: RealtimeEvent = {
        type: 'conversation',
        conversationId: id,
        assigneeId: takes ? access.userId : conversation.assigneeId,
        ...(takes ? { previousAssigneeId: null } : {}),
        reason: 'message',
      };
      const sender = await tx.user.findUnique({
        where: { id: access.userId },
        select: { id: true, name: true },
      });
      return { message: created, event, sender };
    });

    await this.enqueue(access.tenantId, message.id, message.id);
    await this.realtime.publish(access.tenantId, event);

    return {
      id: message.id,
      direction: 'OUTBOUND',
      type: 'TEXT',
      body,
      status: 'QUEUED',
      errorMessage: null,
      sender,
      createdAt: message.createdAt.toISOString(),
    };
  }

  /** Vuelve a intentar un mensaje que falló. Sigue exigiendo la ventana abierta. */
  async retry(access: ResolvedAccess, id: string, messageId: string): Promise<void> {
    const writable = await this.visibleWhere(access, 'conversation:write');
    const event = await runInTenantTransaction(async (tx) => {
      const conversation = await tx.conversation.findFirst({
        where: { AND: [{ id }, writable] },
        select: {
          id: true,
          assigneeId: true,
          windowExpiresAt: true,
          channel: { select: { status: true, credentialsEncrypted: true } },
        },
      });
      if (!conversation) throw notFound('Conversación');
      assertCanSend(conversation, new Date());

      const updated = await tx.message.updateMany({
        where: { id: messageId, conversationId: id, direction: 'OUTBOUND', status: 'FAILED' },
        data: {
          status: 'QUEUED',
          statusUpdatedAt: new Date(),
          errorCode: null,
          errorMessage: null,
        },
      });
      if (updated.count === 0) {
        throw conflict('Este mensaje no se puede reintentar', 'Sólo se reintentan los fallidos.');
      }
      return {
        type: 'conversation',
        conversationId: id,
        assigneeId: conversation.assigneeId,
        reason: 'delivery',
      } satisfies RealtimeEvent;
    });

    // Id de trabajo nuevo: el del intento anterior puede seguir en la lista de
    // fallidos, y BullMQ ignoraría un trabajo con el mismo id.
    await this.enqueue(access.tenantId, messageId, `${messageId}-r${Date.now()}`);
    await this.realtime.publish(access.tenantId, event);
  }

  async markRead(access: ResolvedAccess, id: string): Promise<void> {
    const visible = await this.visibleWhere(access, 'conversation:read');
    const changed = await runInTenantTransaction(async (tx) => {
      const conversation = await tx.conversation.findFirst({
        where: { AND: [{ id }, visible] },
        select: { id: true, assigneeId: true, unreadCount: true },
      });
      if (!conversation) throw notFound('Conversación');
      if (conversation.unreadCount === 0) return null;
      await tx.conversation.update({ where: { id }, data: { unreadCount: 0 } });
      return { assigneeId: conversation.assigneeId };
    });
    // Sólo se avisa si de verdad había algo sin leer.
    if (changed) await this.publish(access.tenantId, id, changed.assigneeId, 'read');
  }

  async setStatus(
    access: ResolvedAccess,
    id: string,
    status: 'OPEN' | 'RESOLVED',
    req: Request,
  ): Promise<ConversationDetail> {
    const writable = await this.visibleWhere(access, 'conversation:write');
    const row = await runInTenantTransaction(async (tx) => {
      const conversation = await tx.conversation.findFirst({
        where: { AND: [{ id }, writable] },
        select: { id: true, status: true },
      });
      if (!conversation) throw notFound('Conversación');
      if (conversation.status !== status) {
        await tx.conversation.update({
          where: { id },
          data: {
            status,
            resolvedAt: status === 'RESOLVED' ? new Date() : null,
            snoozedUntil: null,
          },
        });
      }
      return tx.conversation.findUniqueOrThrow({ where: { id }, select: summarySelect });
    });

    await this.record(access, req, id, row.contact.fullName, { status });
    await this.publish(access.tenantId, id, row.assigneeId, 'status');
    return this.detail(access, row);
  }

  /**
   * Asignar, tomar o liberar.
   *
   *  · Tomar una SIN asignar: basta con poder responder (conversation:write).
   *    La condición `assigneeId IS NULL` va en el propio UPDATE: si dos la
   *    toman a la vez, sólo uno lo consigue y el otro recibe 409.
   *  · Liberar la propia: también con conversation:write.
   *  · Cualquier otra cosa (asignar a otro, quitársela a alguien): exige
   *    conversation:assign, y dentro de su alcance, tanto sobre quien la tenía
   *    como sobre quien la recibe.
   */
  async assign(
    access: ResolvedAccess,
    id: string,
    userId: string | null,
    req: Request,
  ): Promise<ConversationDetail> {
    const canAssign = Boolean(access.permissions['conversation:assign']);
    const readable = await this.visibleWhere(access, 'conversation:read');
    const assignScope = canAssign
      ? await this.accessService.rowFilter(access, 'conversation:assign', 'assigneeId')
      : null;

    const { row, previous } = await runInTenantTransaction(async (tx) => {
      const conversation = await tx.conversation.findFirst({
        where: { AND: [{ id }, readable] },
        select: { id: true, assigneeId: true },
      });
      if (!conversation) throw notFound('Conversación');
      const previous = conversation.assigneeId;
      if (previous === userId) {
        return {
          row: await tx.conversation.findUniqueOrThrow({ where: { id }, select: summarySelect }),
          previous,
        };
      }

      const taking = userId === access.userId && previous === null;
      const releasingOwn = userId === null && previous === access.userId;

      if (taking || releasingOwn) {
        if (!access.permissions['conversation:write']) throw forbidden('responder conversaciones');
        const done = await tx.conversation.updateMany({
          where: { id, assigneeId: previous },
          data: { assigneeId: userId },
        });
        if (done.count === 0) throw alreadyAssigned();
      } else {
        if (!canAssign) {
          if (previous !== null && userId === access.userId) throw alreadyAssigned();
          throw forbidden('asignar conversaciones');
        }
        // Quien la tenía tiene que estar en su alcance (no se la quita a
        // alguien de otro equipo)…
        if (previous !== null && assignScope) {
          const inScope = await tx.conversation.count({
            where: { AND: [{ id }, assignScope as Prisma.ConversationWhereInput] },
          });
          if (inScope === 0) throw forbidden('reasignar conversaciones de otros equipos');
        }
        // …y quien la recibe, también, y tiene que poder verla.
        if (userId !== null) await this.assertAssignable(tx, access, userId);

        const done = await tx.conversation.updateMany({
          where: { id, assigneeId: previous },
          data: { assigneeId: userId },
        });
        if (done.count === 0) throw alreadyAssigned();
      }

      return {
        row: await tx.conversation.findUniqueOrThrow({ where: { id }, select: summarySelect }),
        previous,
      };
    });

    if (previous !== row.assigneeId) {
      await this.record(access, req, id, row.contact.fullName, {
        assigneeId: { from: previous, to: row.assigneeId },
      });
      await this.realtime.publish(access.tenantId, {
        type: 'conversation',
        conversationId: id,
        assigneeId: row.assigneeId,
        previousAssigneeId: previous,
        reason: 'assignment',
      });
    }
    return this.detail(access, row);
  }

  /* ======================================================================== */

  /**
   * Filtro de visibilidad: el alcance del permiso sobre la persona asignada,
   * más las conversaciones sin asignar.
   */
  private async visibleWhere(
    access: ResolvedAccess,
    permission: Permission,
  ): Promise<Prisma.ConversationWhereInput> {
    const scope = await this.accessService.rowFilter(access, permission, 'assigneeId');
    if (!scope) return {};
    return { OR: [scope, { assigneeId: null }] };
  }

  private async assertAssignable(
    tx: TenantTransactionClient,
    access: ResolvedAccess,
    userId: string,
  ): Promise<void> {
    const membership = await tx.membership.findFirst({
      where: { userId, status: 'ACTIVE' },
      select: { id: true },
    });
    const target = membership
      ? await this.accessService.resolve(access.tenantId, membership.id)
      : null;
    if (!target || !target.permissions['conversation:read']) {
      throw new ProblemException({
        type: PROBLEM_TYPES.VALIDATION,
        title: 'No se le puede asignar',
        status: HttpStatus.BAD_REQUEST,
        errors: [
          { field: 'userId', message: 'no es un miembro activo que pueda ver conversaciones' },
        ],
      });
    }
    const scope = access.permissions['conversation:assign'];
    if (scope === 'OWN' && userId !== access.userId) {
      throw forbidden('asignar conversaciones a otras personas');
    }
    if (scope === 'TEAM' && !(await this.accessService.teamUserIds(access)).includes(userId)) {
      throw forbidden('asignar conversaciones fuera de tu equipo');
    }
  }

  private async detail(access: ResolvedAccess, row: SummaryRow): Promise<ConversationDetail> {
    const writable = await this.inScope(access, 'conversation:write', row.assigneeId);
    const assignable = await this.inScope(access, 'conversation:assign', row.assigneeId);
    return {
      ...toSummary(row),
      channelConnected: row.channel.status === 'CONNECTED',
      can: {
        reply: writable,
        take: row.assigneeId === null && Boolean(access.permissions['conversation:write']),
        assign: assignable,
      },
    };
  }

  /** ¿La conversación (por su asignación) entra en el alcance de ese permiso? */
  private async inScope(
    access: ResolvedAccess,
    permission: Permission,
    assigneeId: string | null,
  ): Promise<boolean> {
    const scope = access.permissions[permission];
    if (!scope) return false;
    if (scope === 'ALL' || assigneeId === null || assigneeId === access.userId) return true;
    if (scope === 'TEAM')
      return (await this.accessService.teamUserIds(access)).includes(assigneeId);
    return false;
  }

  private async enqueue(tenantId: string, messageId: string, jobId: string): Promise<void> {
    const job: WhatsappOutboundJob = { messageId, tenantId };
    try {
      await this.outbound.add(QUEUE_NAMES.WHATSAPP_OUTBOUND, job, { jobId });
    } catch (error) {
      // Sin cola no hay envío: el mensaje no puede quedarse «en cola» para
      // siempre. Se marca fallido y el agente lo puede reintentar.
      this.logger.error(`No se pudo encolar el mensaje ${messageId}: ${(error as Error).message}`);
      await runInTenantTransaction((tx) =>
        tx.message.update({
          where: { id: messageId },
          data: {
            status: 'FAILED',
            errorMessage: 'No se pudo poner en cola. Inténtalo de nuevo.',
          },
        }),
      );
      throw new ProblemException({
        type: PROBLEM_TYPES.UNAVAILABLE,
        title: 'No se pudo enviar ahora',
        status: HttpStatus.SERVICE_UNAVAILABLE,
        detail: 'El mensaje quedó marcado como fallido; puedes reintentarlo en unos segundos.',
      });
    }
  }

  private publish(
    tenantId: string,
    conversationId: string,
    assigneeId: string | null,
    reason: RealtimeEvent['reason'],
  ): Promise<void> {
    return this.realtime.publish(tenantId, {
      type: 'conversation',
      conversationId,
      assigneeId,
      reason,
    });
  }

  private record(
    access: ResolvedAccess,
    req: Request,
    id: string,
    label: string,
    changes: Record<string, unknown>,
  ): Promise<void> {
    return this.audit.record({
      tenantId: access.tenantId,
      actorUserId: access.userId,
      action: 'UPDATE',
      resourceType: 'Conversation',
      resourceId: id,
      resourceLabel: label,
      changes,
      ip: req.ip,
      userAgent: req.headers['user-agent']?.slice(0, 500),
      traceId: traceIdOf(req),
    });
  }
}

/* ========================================================================== */

function toSummary(row: SummaryRow): ConversationSummary {
  return {
    id: row.id,
    status: row.status,
    contact: {
      id: row.contact.id,
      name: row.contact.fullName || row.contact.whatsappE164 || 'Sin nombre',
      phone: row.contact.whatsappE164 ?? row.contact.phoneE164,
    },
    channel: { id: row.channel.id, name: row.channel.name, displayId: row.channel.displayId },
    assignee: row.assignee,
    lastMessageAt: row.lastMessageAt?.toISOString() ?? null,
    lastMessagePreview: row.lastMessagePreview,
    lastMessageDirection: row.lastMessageDirection,
    unreadCount: row.unreadCount,
    windowExpiresAt: row.windowExpiresAt?.toISOString() ?? null,
  };
}

function assertCanSend(
  conversation: {
    windowExpiresAt: Date | null;
    channel: { status: string; credentialsEncrypted: string | null };
  },
  now: Date,
): void {
  if (conversation.channel.status !== 'CONNECTED' || !conversation.channel.credentialsEncrypted) {
    throw conflict(
      'El canal está desconectado',
      'Vuelve a conectar el número en Ajustes → Canales para poder responder.',
      INBOX_PROBLEMS.CHANNEL_DISCONNECTED,
    );
  }
  if (!conversation.windowExpiresAt || conversation.windowExpiresAt <= now) {
    throw conflict(
      'Pasaron más de 24 horas desde el último mensaje del cliente',
      'WhatsApp sólo permite responder con texto libre dentro de las 24 horas siguientes al último mensaje del cliente. Fuera de ese plazo hace falta una plantilla aprobada.',
      INBOX_PROBLEMS.WINDOW_CLOSED,
    );
  }
}

const alreadyAssigned = () =>
  conflict(
    'Otra persona ya la tomó',
    'La conversación se asignó mientras tanto. Recarga para ver quién la lleva.',
    INBOX_PROBLEMS.ALREADY_ASSIGNED,
  );

const forbidden = (what: string) =>
  new ProblemException({
    type: PROBLEM_TYPES.FORBIDDEN,
    title: 'No tienes permiso',
    status: HttpStatus.FORBIDDEN,
    detail: `Tu rol no permite ${what}.`,
  });
