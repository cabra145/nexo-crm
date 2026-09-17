import { HttpStatus, Injectable } from '@nestjs/common';
import {
  type ContactCreateInput,
  type ContactDetail,
  type ContactListItem,
  CRM_PROBLEMS,
  type ContactUpdateInput,
  type ListContactsQuery,
  type Paginated,
  paginate,
  PROBLEM_TYPES,
} from '@nexo/contracts';
import { Prisma, runInTenantTransaction, type TenantTransactionClient } from '@nexo/database';
import type { Request } from 'express';
import type { ResolvedAccess } from '../team/access.service';
import { AccessService } from '../team/access.service';
import { loadPlanLimits, lockResource } from '../team/plan-limits';
import { ProblemException } from '../common/problem.exception';
import { traceIdOf } from '../common/trace-id';
import { AuditService } from '../queues/audit.service';
import { notFound } from '../team/team.problems';

const contactSelect = {
  id: true,
  firstName: true,
  lastName: true,
  fullName: true,
  jobTitle: true,
  email: true,
  phoneE164: true,
  whatsappE164: true,
  addressLine: true,
  city: true,
  state: true,
  postalCode: true,
  country: true,
  companyId: true,
  companyName: true,
  lifecycleStage: true,
  source: true,
  ownerId: true,
  createdAt: true,
  updatedAt: true,
  company: { select: { id: true, name: true } },
  owner: { select: { id: true, name: true } },
  tags: { select: { tag: { select: { id: true, name: true, color: true } } } },
} satisfies Prisma.ContactSelect;

type ContactRow = Prisma.ContactGetPayload<{ select: typeof contactSelect }>;

/** Campos que el usuario puede escribir, tal como los espera Prisma. */
type WritableFields = Omit<ContactCreateInput, 'tagIds'>;

/**
 * Contactos: el corazón del CRM.
 *
 * Tres cosas se aplican en CADA operación:
 *
 *   · **Alcance del rol.** El permiso dice si puede tocar contactos; el
 *     alcance, cuáles. Un agente sólo los suyos, un responsable los de su
 *     equipo. El filtro sale de `AccessService.rowFilter`, nunca del cliente.
 *   · **Unicidad real.** Correo y teléfono son únicos por empresa entre los
 *     contactos vivos, con índices parciales en la base: dos altas
 *     simultáneas del mismo correo no pueden colarse.
 *   · **Rastro.** Auditoría (quién cambió qué) y actividad del contacto (su
 *     historia, que ve el usuario).
 */
@Injectable()
export class ContactsService {
  constructor(
    private readonly accessService: AccessService,
    private readonly audit: AuditService,
  ) {}

  /* ======================================================================== */
  /*  Lectura                                                                  */
  /* ======================================================================== */

  async list(
    access: ResolvedAccess,
    query: ListContactsQuery,
  ): Promise<Paginated<ContactListItem>> {
    const scope = await this.accessService.rowFilter(access, 'contact:read');
    const where: Prisma.ContactWhereInput = {
      deletedAt: null,
      ...(scope as Prisma.ContactWhereInput | null),
      ...(query.stage ? { lifecycleStage: query.stage } : {}),
      ...(query.companyId ? { companyId: query.companyId } : {}),
      ...(query.tagId ? { tags: { some: { tagId: query.tagId } } } : {}),
      ...(query.mine ? { ownerId: access.userId } : {}),
      ...(query.unassigned ? { ownerId: null } : query.ownerId ? { ownerId: query.ownerId } : {}),
    };

    if (query.q && query.q.length >= 2) {
      const rows = await this.search(query.q, where, query.limit);
      return { data: rows.map(toListItem), nextCursor: null, hasMore: false };
    }

    const rows = await runInTenantTransaction((tx) =>
      tx.contact.findMany({
        where,
        select: contactSelect,
        // El id es UUID v7: ordenar por id descendente es ordenar por fecha de
        // creación, y sirve de cursor sin columna extra.
        orderBy: { id: 'desc' },
        take: query.limit + 1,
        ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      }),
    );
    const page = paginate(rows, query.limit);
    return { ...page, data: page.data.map(toListItem) };
  }

  /**
   * Búsqueda: texto completo con pesos (nombre > empresa y correo > teléfono y
   * cargo) y, además, coincidencia parcial por trigram para lo que el
   * diccionario no encuentra («erez» → «Pérez») y para los últimos dígitos de
   * un teléfono, que es como la gente busca.
   *
   * La consulta cruda devuelve sólo IDS, ya ordenados por relevancia; los
   * datos se leen después con Prisma, que aplica el ámbito de empresa y las
   * mismas condiciones del listado. La RLS cubre igualmente la consulta cruda.
   */
  private search(q: string, where: Prisma.ContactWhereInput, limit: number): Promise<ContactRow[]> {
    const digits = q.replace(/\D/g, '');
    return runInTenantTransaction(async (tx) => {
      const found = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id::text,
               ts_rank(search_vector, websearch_to_tsquery('spanish', ${q})) AS rank,
               similarity(nexo_unaccent(full_name), nexo_unaccent(${q})) AS sim
          FROM contact
         WHERE deleted_at IS NULL
           AND (
             search_vector @@ websearch_to_tsquery('spanish', ${q})
             OR nexo_unaccent(full_name) ILIKE nexo_unaccent(${'%' + q + '%'})
             OR (${digits} <> '' AND (
                  phone_e164 ILIKE ${'%' + digits + '%'}
                  OR whatsapp_e164 ILIKE ${'%' + digits + '%'}
             ))
           )
         ORDER BY rank DESC, sim DESC, id DESC
         LIMIT ${limit}
      `;
      const ids = found.map((r) => r.id);
      if (ids.length === 0) return [];

      const rows = await tx.contact.findMany({
        where: { ...where, id: { in: ids } },
        select: contactSelect,
      });
      // Se conserva el orden por relevancia de la consulta cruda.
      const byId = new Map(rows.map((r) => [r.id, r]));
      return ids.flatMap((id) => byId.get(id) ?? []);
    });
  }

  async get(access: ResolvedAccess, id: string): Promise<ContactDetail> {
    const row = await runInTenantTransaction((tx) => this.findInScope(tx, access, id));
    return toDetail(row);
  }

  /* ======================================================================== */
  /*  Escritura                                                                */
  /* ======================================================================== */

  async create(
    access: ResolvedAccess,
    input: ContactCreateInput,
    req: Request,
  ): Promise<ContactDetail> {
    const { tagIds, ...fields } = input;

    // El `catch` va FUERA de la transacción: un choque con el índice único la
    // aborta, así que averiguar quién tiene ya ese correo se hace después.
    const row = await runInTenantTransaction(async (tx) => {
      await lockResource(tx, `nexo:contacts:${access.tenantId}`);
      await this.assertQuota(tx);
      await this.assertCompanyExists(tx, fields.companyId);

      const created = await tx.contact.create({
        data: {
          tenantId: access.tenantId,
          ...(writable(fields) as Omit<Prisma.ContactUncheckedCreateInput, 'tenantId'>),
          // Sin responsable indicado, el contacto es de quien lo crea: así
          // un agente ve lo que acaba de dar de alta. `null` explícito es
          // otra cosa —«sin responsable»— y se respeta.
          ownerId: fields.ownerId === undefined ? access.userId : fields.ownerId,
          source: 'manual',
          ...(tagIds?.length
            ? {
                tags: {
                  create: tagIds.map((tagId) => ({ tagId, tenantId: access.tenantId })),
                },
              }
            : {}),
        },
        select: contactSelect,
      });

      await tx.activity.create({
        data: {
          tenantId: access.tenantId,
          type: 'SYSTEM',
          subjectType: 'Contact',
          subjectId: created.id,
          contactId: created.id,
          actorId: access.userId,
          title: 'Contacto creado',
        },
      });
      return created;
    }).catch((error: unknown) => this.rethrow(error, fields));

    await this.record(access, req, 'CREATE', row, {});
    return toDetail(row);
  }

  async update(
    access: ResolvedAccess,
    id: string,
    input: ContactUpdateInput,
    req: Request,
  ): Promise<ContactDetail> {
    const { tagIds, ...fields } = input;

    const { row, changes } = await runInTenantTransaction(async (tx) => {
      const current = await this.findInScope(tx, access, id, 'contact:write');
      await this.assertCompanyExists(tx, fields.companyId);

      const updated = await tx.contact.update({
        where: { id },
        data: {
          ...(writable(fields) as Prisma.ContactUncheckedUpdateInput),
          ...(tagIds
            ? {
                // Reemplazo completo: la lista que llega es la definitiva.
                tags: {
                  deleteMany: {},
                  create: tagIds.map((tagId) => ({ tagId, tenantId: access.tenantId })),
                },
              }
            : {}),
        },
        select: contactSelect,
      });

      const diff = changesBetween(current, updated);
      if (diff.lifecycleStage) {
        await tx.activity.create({
          data: {
            tenantId: access.tenantId,
            type: 'STAGE_CHANGE',
            subjectType: 'Contact',
            subjectId: id,
            contactId: id,
            actorId: access.userId,
            title: `Etapa: ${String(diff.lifecycleStage.antes)} → ${String(diff.lifecycleStage.despues)}`,
            payload: diff.lifecycleStage,
          },
        });
      }
      return { row: updated, changes: diff };
    }).catch((error: unknown) => this.rethrow(error, fields));

    if (Object.keys(changes).length > 0) {
      await this.record(access, req, 'UPDATE', row, changes);
    }
    return toDetail(row);
  }

  /** Borrado lógico: el contacto desaparece de la vista y libera su correo. */
  async remove(access: ResolvedAccess, id: string, req: Request): Promise<void> {
    const row = await runInTenantTransaction(async (tx) => {
      const current = await this.findInScope(tx, access, id, 'contact:delete');
      await tx.contact.update({ where: { id }, data: { deletedAt: new Date() } });
      return current;
    });
    await this.record(access, req, 'DELETE', row, {});
  }

  /* ======================================================================== */
  /*  Reglas                                                                   */
  /* ======================================================================== */

  /**
   * Lee el contacto comprobando el alcance del permiso indicado. Fuera de
   * alcance (de otro agente, o de otra empresa) responde 404: que exista no es
   * información que corresponda dar.
   */
  private async findInScope(
    tx: TenantTransactionClient,
    access: ResolvedAccess,
    id: string,
    permission: 'contact:read' | 'contact:write' | 'contact:delete' = 'contact:read',
  ): Promise<ContactRow> {
    const scope = await this.accessService.rowFilter(access, permission);
    const row = await tx.contact.findFirst({
      where: { id, deletedAt: null, ...(scope as Prisma.ContactWhereInput | null) },
      select: contactSelect,
    });
    if (!row) throw notFound('Contacto');
    return row;
  }

  private async assertQuota(tx: TenantTransactionClient): Promise<void> {
    const { maxContacts } = await loadPlanLimits(tx);
    if (maxContacts === null) return;
    const used = await tx.contact.count({ where: { deletedAt: null } });
    if (used >= maxContacts) {
      throw new ProblemException({
        type: CRM_PROBLEMS.CONTACT_QUOTA,
        title: 'Has llegado al límite de contactos de tu plan',
        status: HttpStatus.FORBIDDEN,
        detail: `Tu plan incluye ${maxContacts} contactos. Elimina los que no uses o mejora el plan.`,
      });
    }
  }

  /** La empresa indicada tiene que existir en ESTA empresa del CRM. */
  private async assertCompanyExists(
    tx: TenantTransactionClient,
    companyId: string | null | undefined,
  ): Promise<void> {
    if (!companyId) return;
    const exists = await tx.company.findFirst({ where: { id: companyId, deletedAt: null } });
    if (!exists) {
      throw new ProblemException({
        type: PROBLEM_TYPES.VALIDATION,
        title: 'La empresa no existe',
        status: HttpStatus.BAD_REQUEST,
        errors: [{ field: 'companyId', message: 'no existe o fue eliminada' }],
      });
    }
  }

  /**
   * Traduce el choque con los índices únicos parciales a un error del campo
   * correspondiente, con el contacto que ya lo usa para poder ofrecerlo.
   */
  /**
   * Traduce el choque con los índices únicos parciales a un error del campo
   * correspondiente, buscando además QUIÉN tiene ya ese correo o teléfono para
   * poder ofrecer «abrir el que ya existe».
   *
   * La búsqueda va FUERA de la transacción que falló: después de un error de
   * restricción, Postgres aborta la transacción y no acepta más consultas en
   * ella (era un 500 disfrazado de conflicto).
   */
  private async explainDuplicate(
    error: Prisma.PrismaClientKnownRequestError,
    fields: Partial<WritableFields>,
  ): Promise<ProblemException> {
    const target = JSON.stringify(error.meta?.target ?? '');
    const field = target.includes('phone') ? 'phoneE164' : 'email';
    const value = field === 'phoneE164' ? fields.phoneE164 : fields.email;
    const existing = value
      ? await runInTenantTransaction((tx) =>
          tx.contact.findFirst({
            where:
              field === 'phoneE164'
                ? { phoneE164: value, deletedAt: null }
                : { email: { equals: value, mode: 'insensitive' }, deletedAt: null },
            select: { id: true, fullName: true },
          }),
        )
      : null;

    return new ProblemException({
      type: CRM_PROBLEMS.DUPLICATE_CONTACT,
      title:
        field === 'phoneE164'
          ? 'Ese teléfono ya está en otro contacto'
          : 'Ese correo ya está en otro contacto',
      status: HttpStatus.CONFLICT,
      detail: existing
        ? `Ya lo tiene ${existing.fullName}. Abre ese contacto en lugar de crear uno nuevo.`
        : 'Otro contacto de tu empresa ya lo usa.',
      errors: [{ field, message: 'ya está en uso' }],
      ...(existing ? { resourceId: existing.id } : {}),
    });
  }

  /** Reintenta el error de duplicado como problema legible; el resto, tal cual. */
  private async rethrow(error: unknown, fields: Partial<WritableFields>): Promise<never> {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      throw await this.explainDuplicate(error, fields);
    }
    throw error;
  }

  private record(
    access: ResolvedAccess,
    req: Request,
    action: 'CREATE' | 'UPDATE' | 'DELETE',
    row: ContactRow,
    changes: Record<string, unknown>,
  ): Promise<void> {
    return this.audit.record({
      tenantId: access.tenantId,
      actorUserId: access.userId,
      action,
      resourceType: 'Contact',
      resourceId: row.id,
      resourceLabel: row.fullName,
      changes,
      ip: req.ip,
      userAgent: req.headers['user-agent']?.slice(0, 500),
      traceId: traceIdOf(req),
    });
  }
}

/* ========================================================================== */

/**
 * Quita las claves ausentes: en Prisma, `undefined` significa «no tocar», y
 * `null` significa «vaciar». El formulario manda null para borrar un dato.
 */
function writable(fields: Partial<WritableFields>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

const AUDITED_FIELDS = [
  'firstName',
  'lastName',
  'jobTitle',
  'companyId',
  'companyName',
  'email',
  'phoneE164',
  'whatsappE164',
  'lifecycleStage',
  'ownerId',
  'city',
  'country',
] as const;

function changesBetween(
  before: ContactRow,
  after: ContactRow,
): Record<string, { antes: unknown; despues: unknown }> {
  const changes: Record<string, { antes: unknown; despues: unknown }> = {};
  for (const field of AUDITED_FIELDS) {
    if (before[field] !== after[field]) {
      changes[field] = { antes: before[field], despues: after[field] };
    }
  }
  return changes;
}

function toListItem(row: ContactRow): ContactListItem {
  return {
    id: row.id,
    fullName: row.fullName,
    jobTitle: row.jobTitle,
    email: row.email,
    phoneE164: row.phoneE164,
    company: row.company,
    companyName: row.companyName,
    lifecycleStage: row.lifecycleStage,
    owner: row.owner,
    tags: row.tags.map((t) => t.tag),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toDetail(row: ContactRow): ContactDetail {
  return {
    ...toListItem(row),
    firstName: row.firstName,
    lastName: row.lastName,
    whatsappE164: row.whatsappE164,
    addressLine: row.addressLine,
    city: row.city,
    state: row.state,
    postalCode: row.postalCode,
    country: row.country,
    source: row.source,
  };
}
