import { Injectable } from '@nestjs/common';
import {
  type CompanyCreateInput,
  type CompanyDetail,
  type CompanyListItem,
  type CompanyUpdateInput,
  type ListCompaniesQuery,
  type Paginated,
  paginate,
} from '@nexo/contracts';
import { Prisma, runInTenantTransaction, type TenantTransactionClient } from '@nexo/database';
import type { Request } from 'express';
import { traceIdOf } from '../common/trace-id';
import { AuditService } from '../queues/audit.service';
import type { ResolvedAccess } from '../team/access.service';
import { notFound } from '../team/team.problems';

const companySelect = {
  id: true,
  name: true,
  legalName: true,
  taxId: true,
  industry: true,
  size: true,
  website: true,
  phone: true,
  email: true,
  addressLine: true,
  city: true,
  state: true,
  postalCode: true,
  country: true,
  createdAt: true,
  updatedAt: true,
  // Sólo los contactos vivos: los borrados no cuentan en la ficha.
  _count: { select: { contacts: { where: { deletedAt: null } } } },
} satisfies Prisma.CompanySelect;

type CompanyRow = Prisma.CompanyGetPayload<{ select: typeof companySelect }>;

/**
 * Empresas (las cuentas del CRM, no los inquilinos del SaaS).
 *
 * No tienen responsable: son datos compartidos de la empresa, así que el
 * permiso decide todo y no hay alcance por filas. Quien puede ver contactos
 * puede ver a qué empresa pertenecen.
 */
@Injectable()
export class CompaniesService {
  constructor(private readonly audit: AuditService) {}

  async list(query: ListCompaniesQuery): Promise<Paginated<CompanyListItem>> {
    const q = query.q?.trim();

    // Con búsqueda, los ids salen de una consulta que ignora acentos y usa el
    // índice trigram (`nexo_unaccent`, en prisma/sql). Sin búsqueda, listado
    // normal paginado por cursor.
    const rows = await runInTenantTransaction(async (tx) => {
      if (q && q.length >= 2) {
        const found = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT id::text
            FROM company
           WHERE deleted_at IS NULL
             AND nexo_unaccent(name) ILIKE nexo_unaccent(${'%' + q + '%'})
           ORDER BY name ASC
           LIMIT ${query.limit}
        `;
        const ids = found.map((r) => r.id);
        if (ids.length === 0) return [];
        const unsorted = await tx.company.findMany({
          where: { id: { in: ids }, deletedAt: null },
          select: companySelect,
        });
        const byId = new Map(unsorted.map((r) => [r.id, r]));
        return ids.flatMap((id) => byId.get(id) ?? []);
      }

      return tx.company.findMany({
        where: { deletedAt: null },
        select: companySelect,
        orderBy: { id: 'desc' },
        take: query.limit + 1,
        ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      });
    });

    if (q) return { data: rows.map(toListItem), nextCursor: null, hasMore: false };
    const page = paginate(rows, query.limit);
    return { ...page, data: page.data.map(toListItem) };
  }

  async get(id: string): Promise<CompanyDetail> {
    const row = await runInTenantTransaction((tx) => this.find(tx, id));
    return toDetail(row);
  }

  async create(
    access: ResolvedAccess,
    input: CompanyCreateInput,
    req: Request,
  ): Promise<CompanyDetail> {
    const row = await runInTenantTransaction((tx) =>
      tx.company.create({
        data: {
          tenantId: access.tenantId,
          ...(clean(input) as Omit<Prisma.CompanyUncheckedCreateInput, 'tenantId'>),
        },
        select: companySelect,
      }),
    );
    await this.record(access, req, 'CREATE', row, {});
    return toDetail(row);
  }

  async update(
    access: ResolvedAccess,
    id: string,
    input: CompanyUpdateInput,
    req: Request,
  ): Promise<CompanyDetail> {
    const { row, changes } = await runInTenantTransaction(async (tx) => {
      const before = await this.find(tx, id);
      const after = await tx.company.update({
        where: { id },
        data: clean(input),
        select: companySelect,
      });
      const diff: Record<string, { antes: unknown; despues: unknown }> = {};
      for (const field of ['name', 'legalName', 'taxId', 'industry', 'website', 'city'] as const) {
        if (before[field] !== after[field]) {
          diff[field] = { antes: before[field], despues: after[field] };
        }
      }
      return { row: after, changes: diff };
    });

    if (Object.keys(changes).length > 0) await this.record(access, req, 'UPDATE', row, changes);
    return toDetail(row);
  }

  /**
   * Borrado lógico. Sus contactos NO se borran: se desvinculan, conservando el
   * nombre de la empresa como texto para no perder el dato de dónde trabajan.
   */
  async remove(access: ResolvedAccess, id: string, req: Request): Promise<void> {
    const row = await runInTenantTransaction(async (tx) => {
      const current = await this.find(tx, id);
      await tx.contact.updateMany({
        where: { companyId: id },
        data: { companyId: null, companyName: current.name },
      });
      await tx.company.update({ where: { id }, data: { deletedAt: new Date() } });
      return current;
    });
    await this.record(access, req, 'DELETE', row, {
      contactosDesvinculados: { antes: row._count.contacts, despues: 0 },
    });
  }

  private async find(tx: TenantTransactionClient, id: string): Promise<CompanyRow> {
    const row = await tx.company.findFirst({
      where: { id, deletedAt: null },
      select: companySelect,
    });
    if (!row) throw notFound('Empresa');
    return row;
  }

  private record(
    access: ResolvedAccess,
    req: Request,
    action: 'CREATE' | 'UPDATE' | 'DELETE',
    row: CompanyRow,
    changes: Record<string, unknown>,
  ): Promise<void> {
    return this.audit.record({
      tenantId: access.tenantId,
      actorUserId: access.userId,
      action,
      resourceType: 'Company',
      resourceId: row.id,
      resourceLabel: row.name,
      changes,
      ip: req.ip,
      userAgent: req.headers['user-agent']?.slice(0, 500),
      traceId: traceIdOf(req),
    });
  }
}

/* ========================================================================== */

/** `undefined` en Prisma significa «no tocar»: se quitan las claves ausentes. */
function clean(input: Partial<CompanyCreateInput>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

function toListItem(row: CompanyRow): CompanyListItem {
  return {
    id: row.id,
    name: row.name,
    industry: row.industry,
    city: row.city,
    country: row.country,
    contactCount: row._count.contacts,
    createdAt: row.createdAt.toISOString(),
  };
}

function toDetail(row: CompanyRow): CompanyDetail {
  return {
    ...toListItem(row),
    legalName: row.legalName,
    taxId: row.taxId,
    size: row.size,
    website: row.website,
    phone: row.phone,
    email: row.email,
    addressLine: row.addressLine,
    state: row.state,
    postalCode: row.postalCode,
    updatedAt: row.updatedAt.toISOString(),
  };
}
