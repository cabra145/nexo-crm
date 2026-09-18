import { HttpStatus, Injectable } from '@nestjs/common';
import {
  type BoardColumn,
  type BoardQuery,
  type BoardView,
  type DealCard,
  type DealCreateInput,
  type DealDetail,
  type DealLoseInput,
  type DealMoveInput,
  type DealStatus,
  type DealUpdateInput,
  type LostReasonView,
  type PipelineView,
  PROBLEM_TYPES,
  type StageType,
  type StageView,
} from '@nexo/contracts';
import { Prisma, runInTenantTransaction, type TenantTransactionClient } from '@nexo/database';
import type { Request } from 'express';
import { ProblemException } from '../common/problem.exception';
import { traceIdOf } from '../common/trace-id';
import { AuditService } from '../queues/audit.service';
import type { ResolvedAccess } from '../team/access.service';
import { AccessService } from '../team/access.service';
import { lockResource } from '../team/plan-limits';
import { conflict, notFound } from '../team/team.problems';

const dealSelect = {
  id: true,
  title: true,
  value: true,
  currency: true,
  probability: true,
  status: true,
  stageId: true,
  pipelineId: true,
  position: true,
  ownerId: true,
  expectedCloseAt: true,
  closedAt: true,
  stageEnteredAt: true,
  createdAt: true,
  lostReasonNote: true,
  contact: { select: { id: true, fullName: true } },
  company: { select: { id: true, name: true } },
  owner: { select: { id: true, name: true } },
  stage: { select: { id: true, name: true, type: true, rottingDays: true } },
  lostReason: { select: { id: true, name: true } },
} satisfies Prisma.DealSelect;

type DealRow = Prisma.DealGetPayload<{ select: typeof dealSelect }>;

/** Separación inicial entre tarjetas. Deja sitio para insertar entre dos. */
const STEP = 1000;

/**
 * Hueco mínimo entre dos posiciones antes de reequilibrar la columna.
 *
 * Con `double precision`, partir el hueco por la mitad unas cincuenta veces
 * seguidas en el mismo punto lo agota. Cuando pasa —y sólo entonces— se
 * renumera la columna entera con `rebalance_stage_positions`.
 */
const MIN_GAP = 0.0001;

/**
 * Embudo de ventas: oportunidades y el tablero.
 *
 * Mover una tarjeta escribe UNA fila: el servidor toma el punto medio entre
 * las dos vecinas que indica el cliente. El cliente nunca manda un número de
 * posición, así que dos personas moviendo a la vez no pueden escribir órdenes
 * incompatibles; el bloqueo por columna serializa el cálculo.
 *
 * Cada cambio de etapa cierra el tramo anterior del historial y abre otro:
 * sin eso, «cuánto tarda una oportunidad en negociación» no se puede
 * reconstruir después.
 */
@Injectable()
export class DealsService {
  constructor(
    private readonly accessService: AccessService,
    private readonly audit: AuditService,
  ) {}

  /* ======================================================================== */
  /*  Tablero                                                                  */
  /* ======================================================================== */

  async board(access: ResolvedAccess, query: BoardQuery): Promise<BoardView> {
    const scope = await this.accessService.rowFilter(access, 'deal:read');

    return runInTenantTransaction(async (tx) => {
      const pipelines = await tx.pipeline.findMany({
        where: { archivedAt: null },
        select: { id: true, name: true, isDefault: true, sortOrder: true },
        orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
      });
      if (pipelines.length === 0) throw notFound('Embudo');

      const chosen =
        pipelines.find((p) => p.id === query.pipelineId) ??
        pipelines.find((p) => p.isDefault) ??
        pipelines[0]!;

      const stages = await tx.pipelineStage.findMany({
        where: { pipelineId: chosen.id },
        select: {
          id: true,
          name: true,
          type: true,
          color: true,
          probability: true,
          position: true,
          rottingDays: true,
        },
        orderBy: [{ position: 'asc' }, { id: 'asc' }],
      });

      const where: Prisma.DealWhereInput = {
        deletedAt: null,
        pipelineId: chosen.id,
        ...(scope as Prisma.DealWhereInput | null),
        ...(query.mine ? { ownerId: access.userId } : {}),
      };

      // Totales de la columna entera, aunque se muestren menos tarjetas.
      const totals = await tx.deal.groupBy({
        by: ['stageId'],
        where,
        _count: { _all: true },
        _sum: { value: true },
      });
      const totalByStage = new Map(totals.map((t) => [t.stageId, t]));

      const columns: BoardColumn[] = [];
      for (const stage of stages) {
        const deals = await tx.deal.findMany({
          where: { ...where, stageId: stage.id },
          select: dealSelect,
          // Las cerradas, por lo más reciente; las abiertas, por su orden.
          orderBy:
            stage.type === 'OPEN'
              ? [{ position: 'asc' }, { id: 'asc' }]
              : [{ closedAt: 'desc' }, { id: 'desc' }],
          take: query.perStage,
        });
        const total = totalByStage.get(stage.id);
        columns.push({
          stage: toStageView(stage),
          deals: deals.map(toCard),
          totalCount: total?._count._all ?? 0,
          totalValue: Number(total?._sum.value ?? 0),
        });
      }

      const tenant = await tx.tenant.findUniqueOrThrow({
        where: { id: access.tenantId },
        select: { currency: true },
      });

      return {
        pipeline: { ...chosen, stages: stages.map(toStageView) } satisfies PipelineView,
        pipelines: pipelines.map((p) => ({ id: p.id, name: p.name })),
        columns,
        currency: tenant.currency,
      };
    });
  }

  async lostReasons(): Promise<LostReasonView[]> {
    return runInTenantTransaction((tx) =>
      tx.lostReason.findMany({
        where: { active: true },
        select: { id: true, name: true },
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      }),
    );
  }

  async get(access: ResolvedAccess, id: string): Promise<DealDetail> {
    return runInTenantTransaction(async (tx) => {
      const deal = await this.findInScope(tx, access, id, 'deal:read');
      const history = await tx.dealStageHistory.findMany({
        where: { dealId: id },
        select: {
          stageId: true,
          enteredAt: true,
          exitedAt: true,
          durationSeconds: true,
          stage: { select: { name: true } },
        },
        orderBy: { enteredAt: 'asc' },
      });
      return {
        ...toCard(deal),
        pipelineId: deal.pipelineId,
        stageName: deal.stage.name,
        closedAt: deal.closedAt?.toISOString() ?? null,
        lostReason: deal.lostReason,
        lostReasonNote: deal.lostReasonNote,
        history: history.map((h) => ({
          stageId: h.stageId,
          stageName: h.stage.name,
          enteredAt: h.enteredAt.toISOString(),
          exitedAt: h.exitedAt?.toISOString() ?? null,
          durationSeconds: h.durationSeconds,
        })),
      };
    });
  }

  /* ======================================================================== */
  /*  Altas y cambios                                                          */
  /* ======================================================================== */

  async create(access: ResolvedAccess, input: DealCreateInput, req: Request): Promise<DealDetail> {
    const id = await runInTenantTransaction(async (tx) => {
      const pipeline = input.pipelineId
        ? await tx.pipeline.findFirst({
            where: { id: input.pipelineId, archivedAt: null },
            select: { id: true },
          })
        : await tx.pipeline.findFirst({
            where: { archivedAt: null },
            select: { id: true },
            orderBy: [{ isDefault: 'desc' }, { sortOrder: 'asc' }],
          });
      if (!pipeline) throw notFound('Embudo');

      const stage = input.stageId
        ? await tx.pipelineStage.findFirst({
            where: { id: input.stageId, pipelineId: pipeline.id },
            select: { id: true, probability: true, type: true },
          })
        : await tx.pipelineStage.findFirst({
            where: { pipelineId: pipeline.id },
            select: { id: true, probability: true, type: true },
            orderBy: { position: 'asc' },
          });
      if (!stage) throw notFound('Etapa');

      await this.assertLinks(tx, access, input.contactId, input.companyId);
      await lockResource(tx, `nexo:deals:${access.tenantId}:${stage.id}`);

      const last = await tx.deal.findFirst({
        where: { stageId: stage.id, deletedAt: null },
        select: { position: true },
        orderBy: { position: 'desc' },
      });

      const created = await tx.deal.create({
        data: {
          tenantId: access.tenantId,
          title: input.title,
          pipelineId: pipeline.id,
          stageId: stage.id,
          contactId: input.contactId ?? null,
          companyId: input.companyId ?? null,
          ownerId: input.ownerId === undefined ? access.userId : input.ownerId,
          value: input.value,
          ...(input.currency ? { currency: input.currency } : {}),
          probability: input.probability ?? stage.probability,
          expectedCloseAt: input.expectedCloseAt ?? null,
          position: (last?.position ?? 0) + STEP,
          source: 'manual',
          status: stageStatus(stage.type),
          ...(stage.type !== 'OPEN' ? { closedAt: new Date() } : {}),
        },
        select: { id: true, title: true, contactId: true },
      });

      await tx.dealStageHistory.create({
        data: {
          tenantId: access.tenantId,
          dealId: created.id,
          stageId: stage.id,
          movedByUserId: access.userId,
        },
      });
      if (created.contactId) {
        await tx.activity.create({
          data: {
            tenantId: access.tenantId,
            type: 'SYSTEM',
            subjectType: 'Deal',
            subjectId: created.id,
            contactId: created.contactId,
            dealId: created.id,
            actorId: access.userId,
            title: `Oportunidad creada: ${created.title}`,
          },
        });
      }
      return created.id;
    });

    const detail = await this.get(access, id);
    await this.record(access, req, 'CREATE', id, detail.title, {});
    return detail;
  }

  async update(
    access: ResolvedAccess,
    id: string,
    input: DealUpdateInput,
    req: Request,
  ): Promise<DealDetail> {
    const changes = await runInTenantTransaction(async (tx) => {
      const before = await this.findInScope(tx, access, id, 'deal:write');
      await this.assertLinks(tx, access, input.contactId, input.companyId);

      const after = await tx.deal.update({
        where: { id },
        data: {
          ...(input.title !== undefined ? { title: input.title } : {}),
          ...(input.contactId !== undefined ? { contactId: input.contactId } : {}),
          ...(input.companyId !== undefined ? { companyId: input.companyId } : {}),
          ...(input.ownerId !== undefined ? { ownerId: input.ownerId } : {}),
          ...(input.value !== undefined ? { value: input.value } : {}),
          ...(input.currency !== undefined ? { currency: input.currency } : {}),
          ...(input.probability !== undefined ? { probability: input.probability } : {}),
          ...(input.expectedCloseAt !== undefined
            ? { expectedCloseAt: input.expectedCloseAt }
            : {}),
        },
        select: dealSelect,
      });

      const diff: Record<string, { antes: unknown; despues: unknown }> = {};
      if (before.title !== after.title) diff.title = { antes: before.title, despues: after.title };
      if (!before.value.equals(after.value)) {
        diff.value = { antes: Number(before.value), despues: Number(after.value) };
      }
      if (before.ownerId !== after.ownerId) {
        diff.ownerId = { antes: before.ownerId, despues: after.ownerId };
      }
      return diff;
    });

    const detail = await this.get(access, id);
    if (Object.keys(changes).length > 0) {
      await this.record(access, req, 'UPDATE', id, detail.title, changes);
    }
    return detail;
  }

  /**
   * Mueve una tarjeta a una etapa y a un hueco entre dos vecinas.
   *
   * Mover a una etapa de tipo «ganado» o «perdido» cierra la oportunidad, y
   * devolverla a una etapa abierta la reabre: es lo que espera quien arrastra
   * la tarjeta, sin pedirle además que cambie un estado aparte.
   */
  async move(
    access: ResolvedAccess,
    id: string,
    input: DealMoveInput,
    req: Request,
    extra: { lost?: DealLoseInput; value?: number } = {},
  ): Promise<DealDetail> {
    const changes = await runInTenantTransaction(async (tx) => {
      const before = await this.findInScope(tx, access, id, 'deal:write');
      const stage = await tx.pipelineStage.findFirst({
        where: { id: input.stageId, pipelineId: before.pipelineId },
        select: { id: true, name: true, type: true, probability: true },
      });
      if (!stage) throw notFound('Etapa');

      // El cálculo de la posición se serializa por columna.
      await lockResource(tx, `nexo:deals:${access.tenantId}:${stage.id}`);
      const position = await this.positionBetween(tx, access, stage.id, id, input);

      const movingStage = before.stageId !== stage.id;
      const status = stageStatus(stage.type);

      await tx.deal.update({
        where: { id },
        data: {
          stageId: stage.id,
          position,
          status,
          ...(movingStage ? { stageEnteredAt: new Date() } : {}),
          ...(status === 'OPEN'
            ? { closedAt: null, lostReasonId: null, lostReasonNote: null }
            : { closedAt: before.closedAt ?? new Date() }),
          ...(status === 'WON' ? { probability: 100 } : {}),
          ...(status === 'LOST' ? { probability: 0 } : {}),
          ...(status === 'OPEN' && movingStage ? { probability: stage.probability } : {}),
          ...(extra.value !== undefined ? { value: extra.value } : {}),
          ...(extra.lost
            ? {
                lostReasonId: extra.lost.lostReasonId ?? null,
                lostReasonNote: extra.lost.note ?? null,
              }
            : {}),
        },
      });

      if (movingStage) {
        await this.closeHistory(tx, id);
        await tx.dealStageHistory.create({
          data: {
            tenantId: access.tenantId,
            dealId: id,
            stageId: stage.id,
            fromStageId: before.stageId,
            movedByUserId: access.userId,
          },
        });
        if (before.contact) {
          await tx.activity.create({
            data: {
              tenantId: access.tenantId,
              type: 'STAGE_CHANGE',
              subjectType: 'Deal',
              subjectId: id,
              contactId: before.contact.id,
              dealId: id,
              actorId: access.userId,
              title: `${before.title}: ${before.stage.name} → ${stage.name}`,
            },
          });
        }
      }

      return movingStage ? { etapa: { antes: before.stage.name, despues: stage.name } } : {};
    });

    const detail = await this.get(access, id);
    if (Object.keys(changes).length > 0) {
      await this.record(access, req, 'UPDATE', id, detail.title, changes);
    }
    return detail;
  }

  /** Atajo: mueve a la primera etapa «ganado» del embudo. */
  async win(
    access: ResolvedAccess,
    id: string,
    value: number | undefined,
    req: Request,
  ): Promise<DealDetail> {
    const stageId = await this.closingStage(access, id, 'WON');
    return this.move(access, id, { stageId }, req, { value });
  }

  /** Atajo: mueve a la primera etapa «perdido», con su motivo. */
  async lose(
    access: ResolvedAccess,
    id: string,
    input: DealLoseInput,
    req: Request,
  ): Promise<DealDetail> {
    const stageId = await this.closingStage(access, id, 'LOST');
    return this.move(access, id, { stageId }, req, { lost: input });
  }

  async remove(access: ResolvedAccess, id: string, req: Request): Promise<void> {
    const title = await runInTenantTransaction(async (tx) => {
      const deal = await this.findInScope(tx, access, id, 'deal:delete');
      await tx.deal.update({ where: { id }, data: { deletedAt: new Date() } });
      return deal.title;
    });
    await this.record(access, req, 'DELETE', id, title, {});
  }

  /* ======================================================================== */
  /*  Interno                                                                  */
  /* ======================================================================== */

  /**
   * Punto medio entre las dos vecinas indicadas. Si el hueco se ha agotado,
   * se renumera la columna (una vez) y se recalcula.
   */
  private async positionBetween(
    tx: TenantTransactionClient,
    access: ResolvedAccess,
    stageId: string,
    dealId: string,
    input: DealMoveInput,
    retry = true,
  ): Promise<number> {
    const neighbour = async (id: string | null | undefined) => {
      if (!id) return null;
      const row = await tx.deal.findFirst({
        where: { id, stageId, deletedAt: null },
        select: { position: true },
      });
      if (!row) {
        throw new ProblemException({
          type: PROBLEM_TYPES.CONFLICT,
          title: 'La tarjeta de referencia ya no está ahí',
          status: HttpStatus.CONFLICT,
          detail: 'Alguien movió las tarjetas mientras arrastrabas. Vuelve a intentarlo.',
        });
      }
      return row.position;
    };

    const after = await neighbour(input.afterDealId);
    const before = await neighbour(input.beforeDealId);

    if (after !== null && before !== null) {
      if (Math.abs(before - after) < MIN_GAP) {
        if (!retry) throw new Error('No se pudo reequilibrar la columna del embudo');
        await tx.$executeRaw`SELECT rebalance_stage_positions(${access.tenantId}::uuid, ${stageId}::uuid)`;
        return this.positionBetween(tx, access, stageId, dealId, input, false);
      }
      return (after + before) / 2;
    }
    if (after !== null) return after + STEP;
    if (before !== null) return before - STEP;

    // Columna vacía, o se suelta sin vecinas: al final.
    const last = await tx.deal.findFirst({
      where: { stageId, deletedAt: null, NOT: { id: dealId } },
      select: { position: true },
      orderBy: { position: 'desc' },
    });
    return (last?.position ?? 0) + STEP;
  }

  private async closingStage(
    access: ResolvedAccess,
    dealId: string,
    type: 'WON' | 'LOST',
  ): Promise<string> {
    return runInTenantTransaction(async (tx) => {
      const deal = await this.findInScope(tx, access, dealId, 'deal:write');
      const stage = await tx.pipelineStage.findFirst({
        where: { pipelineId: deal.pipelineId, type },
        select: { id: true },
        orderBy: { position: 'asc' },
      });
      if (!stage) {
        throw conflict(
          type === 'WON'
            ? 'Este embudo no tiene una etapa de ganado'
            : 'Este embudo no tiene una etapa de perdido',
        );
      }
      return stage.id;
    });
  }

  private async closeHistory(tx: TenantTransactionClient, dealId: string): Promise<void> {
    // La duración se guarda al salir: así el panel comercial no tiene que
    // calcular intervalos en cada consulta.
    await tx.$executeRaw`
      UPDATE deal_stage_history
         SET exited_at = now(),
             duration_seconds = EXTRACT(EPOCH FROM (now() - entered_at))::int
       WHERE deal_id = ${dealId}::uuid AND exited_at IS NULL
    `;
  }

  private async findInScope(
    tx: TenantTransactionClient,
    access: ResolvedAccess,
    id: string,
    permission: 'deal:read' | 'deal:write' | 'deal:delete',
  ): Promise<DealRow> {
    const scope = await this.accessService.rowFilter(access, permission);
    const row = await tx.deal.findFirst({
      where: { id, deletedAt: null, ...(scope as Prisma.DealWhereInput | null) },
      select: dealSelect,
    });
    if (!row) throw notFound('Oportunidad');
    return row;
  }

  /** Contacto dentro del alcance y empresa existente, si se indican. */
  private async assertLinks(
    tx: TenantTransactionClient,
    access: ResolvedAccess,
    contactId: string | null | undefined,
    companyId: string | null | undefined,
  ): Promise<void> {
    if (contactId) {
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
    }
    if (companyId) {
      const company = await tx.company.findFirst({
        where: { id: companyId, deletedAt: null },
        select: { id: true },
      });
      if (!company) {
        throw new ProblemException({
          type: PROBLEM_TYPES.VALIDATION,
          title: 'La empresa no existe',
          status: HttpStatus.BAD_REQUEST,
          errors: [{ field: 'companyId', message: 'no existe o fue eliminada' }],
        });
      }
    }
  }

  private record(
    access: ResolvedAccess,
    req: Request,
    action: 'CREATE' | 'UPDATE' | 'DELETE',
    id: string,
    label: string,
    changes: Record<string, unknown>,
  ): Promise<void> {
    return this.audit.record({
      tenantId: access.tenantId,
      actorUserId: access.userId,
      action,
      resourceType: 'Deal',
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

const stageStatus = (type: StageType): DealStatus =>
  type === 'WON' ? 'WON' : type === 'LOST' ? 'LOST' : 'OPEN';

function toStageView(stage: {
  id: string;
  name: string;
  type: string;
  color: string;
  probability: number;
  position: number;
  rottingDays: number | null;
}): StageView {
  return { ...stage, type: stage.type as StageType };
}

function toCard(row: DealRow): DealCard {
  const rotting = row.stage.rottingDays;
  const stalled =
    row.status === 'OPEN' &&
    rotting !== null &&
    Date.now() - row.stageEnteredAt.getTime() > rotting * 86_400_000;

  return {
    id: row.id,
    title: row.title,
    value: Number(row.value),
    currency: row.currency,
    probability: row.probability,
    status: row.status,
    stageId: row.stageId,
    position: row.position,
    contact: row.contact,
    company: row.company,
    owner: row.owner,
    expectedCloseAt: row.expectedCloseAt?.toISOString() ?? null,
    stalled,
    stageEnteredAt: row.stageEnteredAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  };
}
