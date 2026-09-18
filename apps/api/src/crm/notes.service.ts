import { Injectable } from '@nestjs/common';
import type { ActivityView, NoteCreateInput, NoteUpdateInput, NoteView } from '@nexo/contracts';
import { Prisma, runInTenantTransaction, type TenantTransactionClient } from '@nexo/database';
import type { Request } from 'express';
import { traceIdOf } from '../common/trace-id';
import { AuditService } from '../queues/audit.service';
import type { ResolvedAccess } from '../team/access.service';
import { AccessService } from '../team/access.service';
import { notFound, notYours } from '../team/team.problems';

const noteSelect = {
  id: true,
  body: true,
  authorId: true,
  contactId: true,
  createdAt: true,
  updatedAt: true,
  author: { select: { id: true, name: true } },
} satisfies Prisma.NoteSelect;

type NoteRow = Prisma.NoteGetPayload<{ select: typeof noteSelect }>;

/**
 * Notas y historia de un contacto.
 *
 * Quien puede ver el contacto ve sus notas y su historia: el alcance se
 * comprueba sobre el CONTACTO, no sobre cada nota.
 *
 * Editar o borrar una nota queda para su AUTOR y para quien administra los
 * datos de toda la empresa (`contact:delete` con alcance de empresa). Un
 * responsable de equipo lee las notas de su gente, pero no las reescribe: lo
 * que alguien anotó es su testimonio de lo que pasó.
 */
@Injectable()
export class NotesService {
  constructor(
    private readonly accessService: AccessService,
    private readonly audit: AuditService,
  ) {}

  async list(access: ResolvedAccess, contactId: string): Promise<NoteView[]> {
    const rows = await runInTenantTransaction(async (tx) => {
      await this.assertContactInScope(tx, access, contactId);
      return tx.note.findMany({
        where: { contactId, deletedAt: null },
        select: noteSelect,
        orderBy: [{ pinned: 'desc' }, { id: 'desc' }],
        take: 100,
      });
    });
    return rows.map((row) => this.toView(row, access));
  }

  async create(access: ResolvedAccess, input: NoteCreateInput, req: Request): Promise<NoteView> {
    const row = await runInTenantTransaction(async (tx) => {
      await this.assertContactInScope(tx, access, input.contactId);
      const created = await tx.note.create({
        data: {
          tenantId: access.tenantId,
          contactId: input.contactId,
          body: input.body,
          authorId: access.userId,
        },
        select: noteSelect,
      });
      // La nota también entra en la historia del contacto, para que la línea
      // de tiempo cuente lo ocurrido sin tener que mirar en dos sitios.
      await tx.activity.create({
        data: {
          tenantId: access.tenantId,
          type: 'NOTE',
          subjectType: 'Note',
          subjectId: created.id,
          contactId: input.contactId,
          actorId: access.userId,
          title: 'Nota añadida',
          summary: input.body.length > 160 ? `${input.body.slice(0, 157)}…` : input.body,
        },
      });
      return created;
    });

    await this.record(access, req, 'CREATE', row, input.contactId);
    return this.toView(row, access);
  }

  async update(
    access: ResolvedAccess,
    id: string,
    input: NoteUpdateInput,
    req: Request,
  ): Promise<NoteView> {
    const row = await runInTenantTransaction(async (tx) => {
      const current = await this.findEditable(tx, access, id);
      return tx.note.update({
        where: { id: current.id },
        data: { body: input.body },
        select: noteSelect,
      });
    });
    await this.record(access, req, 'UPDATE', row, null);
    return this.toView(row, access);
  }

  async remove(access: ResolvedAccess, id: string, req: Request): Promise<void> {
    const row = await runInTenantTransaction(async (tx) => {
      const current = await this.findEditable(tx, access, id);
      await tx.note.update({ where: { id: current.id }, data: { deletedAt: new Date() } });
      return current;
    });
    await this.record(access, req, 'DELETE', row, null);
  }

  /** Historia del contacto: lo que ha pasado, de lo más reciente a lo más antiguo. */
  async timeline(access: ResolvedAccess, contactId: string): Promise<ActivityView[]> {
    const rows = await runInTenantTransaction(async (tx) => {
      await this.assertContactInScope(tx, access, contactId);
      return tx.activity.findMany({
        where: { contactId },
        select: {
          id: true,
          type: true,
          title: true,
          summary: true,
          occurredAt: true,
          actor: { select: { id: true, name: true } },
        },
        orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
        take: 100,
      });
    });
    return rows.map((row) => ({
      id: row.id,
      type: row.type,
      title: row.title,
      summary: row.summary,
      actor: row.actor,
      occurredAt: row.occurredAt.toISOString(),
    }));
  }

  /* ------------------------------------------------------------------------ */

  private async assertContactInScope(
    tx: TenantTransactionClient,
    access: ResolvedAccess,
    contactId: string,
  ): Promise<void> {
    const scope = await this.accessService.rowFilter(access, 'contact:read');
    const contact = await tx.contact.findFirst({
      where: { id: contactId, deletedAt: null, ...(scope as Prisma.ContactWhereInput | null) },
      select: { id: true },
    });
    if (!contact) throw notFound('Contacto');
  }

  private async findEditable(
    tx: TenantTransactionClient,
    access: ResolvedAccess,
    id: string,
  ): Promise<NoteRow> {
    const note = await tx.note.findFirst({ where: { id, deletedAt: null }, select: noteSelect });
    // Primero el alcance del contacto: si no puede verlo, la nota «no existe».
    if (!note?.contactId) throw notFound('Nota');
    await this.assertContactInScope(tx, access, note.contactId);
    if (!this.canEdit(note, access)) {
      throw notYours('Esta nota la escribió otra persona.');
    }
    return note;
  }

  private canEdit(note: Pick<NoteRow, 'authorId'>, access: ResolvedAccess): boolean {
    return note.authorId === access.userId || access.permissions['contact:delete'] === 'ALL';
  }

  private toView(row: NoteRow, access: ResolvedAccess): NoteView {
    return {
      id: row.id,
      body: row.body,
      author: row.author,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      canEdit: this.canEdit(row, access),
    };
  }

  private record(
    access: ResolvedAccess,
    req: Request,
    action: 'CREATE' | 'UPDATE' | 'DELETE',
    row: NoteRow,
    contactId: string | null,
  ): Promise<void> {
    return this.audit.record({
      tenantId: access.tenantId,
      actorUserId: access.userId,
      action,
      resourceType: 'Note',
      resourceId: row.id,
      resourceLabel: contactId ? `Nota de contacto ${contactId}` : 'Nota',
      ip: req.ip,
      userAgent: req.headers['user-agent']?.slice(0, 500),
      traceId: traceIdOf(req),
    });
  }
}
