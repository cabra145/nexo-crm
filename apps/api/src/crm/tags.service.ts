import { Injectable } from '@nestjs/common';
import { type TagCreateInput, TAG_COLORS, type TagView } from '@nexo/contracts';
import { Prisma, runInTenantTransaction } from '@nexo/database';
import type { Request } from 'express';
import { traceIdOf } from '../common/trace-id';
import { AuditService } from '../queues/audit.service';
import type { ResolvedAccess } from '../team/access.service';
import { conflict, notFound } from '../team/team.problems';

/**
 * Etiquetas de contactos: vocabulario compartido de la empresa, sin alcance
 * por filas. Cualquiera que pueda ver contactos ve las etiquetas; crearlas
 * exige poder editar contactos.
 */
@Injectable()
export class TagsService {
  constructor(private readonly audit: AuditService) {}

  async list(): Promise<TagView[]> {
    const rows = await runInTenantTransaction((tx) =>
      tx.tag.findMany({
        select: { id: true, name: true, color: true, _count: { select: { contacts: true } } },
        orderBy: { name: 'asc' },
      }),
    );
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      color: r.color,
      contactCount: r._count.contacts,
    }));
  }

  async create(access: ResolvedAccess, input: TagCreateInput, req: Request): Promise<TagView> {
    const row = await runInTenantTransaction(async (tx) => {
      try {
        return await tx.tag.create({
          data: {
            tenantId: access.tenantId,
            name: input.name,
            // Sin color elegido, uno de la paleta según cuántas haya: así dos
            // etiquetas seguidas no salen del mismo color.
            color: input.color ?? TAG_COLORS[(await tx.tag.count()) % TAG_COLORS.length]!,
          },
          select: { id: true, name: true, color: true },
        });
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
          throw conflict('Ya existe una etiqueta con ese nombre');
        }
        throw error;
      }
    });

    await this.audit.record({
      tenantId: access.tenantId,
      actorUserId: access.userId,
      action: 'CREATE',
      resourceType: 'Tag',
      resourceId: row.id,
      resourceLabel: row.name,
      ip: req.ip,
      userAgent: req.headers['user-agent']?.slice(0, 500),
      traceId: traceIdOf(req),
    });
    return { ...row, contactCount: 0 };
  }

  /** Eliminar una etiqueta la quita de los contactos que la tenían. */
  async remove(access: ResolvedAccess, id: string, req: Request): Promise<void> {
    const row = await runInTenantTransaction(async (tx) => {
      const tag = await tx.tag.findUnique({ where: { id }, select: { id: true, name: true } });
      if (!tag) throw notFound('Etiqueta');
      await tx.tag.delete({ where: { id } });
      return tag;
    });

    await this.audit.record({
      tenantId: access.tenantId,
      actorUserId: access.userId,
      action: 'DELETE',
      resourceType: 'Tag',
      resourceId: row.id,
      resourceLabel: row.name,
      ip: req.ip,
      userAgent: req.headers['user-agent']?.slice(0, 500),
      traceId: traceIdOf(req),
    });
  }
}
