import { Injectable } from '@nestjs/common';
import {
  canGrant,
  normalizePermissionMap,
  type PermissionMap,
  type RoleInput,
  type RolesView,
  type RoleView,
} from '@nexo/contracts';
import { Prisma, runInTenantTransaction, type TenantTransactionClient } from '@nexo/database';
import type { Request } from 'express';
import { traceIdOf } from '../common/trace-id';
import { AuditService } from '../queues/audit.service';
import type { ResolvedAccess } from './access.service';
import { AccessService } from './access.service';
import { loadPlanLimits, lockTeam } from './plan-limits';
import { conflict, escalation, featureUnavailable, notFound } from './team.problems';

const roleSelect = {
  id: true,
  key: true,
  name: true,
  description: true,
  isSystem: true,
  createdAt: true,
  permissions: { select: { permission: true, scope: true } },
  _count: { select: { memberships: true } },
} satisfies Prisma.RoleSelect;

type RoleRow = Prisma.RoleGetPayload<{ select: typeof roleSelect }>;

const SYSTEM_ORDER: Record<string, number> = {
  OWNER: 0,
  ADMIN: 1,
  MANAGER: 2,
  AGENT: 3,
  VIEWER: 4,
};

/**
 * Roles de la empresa. Los cinco del sistema son de sólo lectura; los
 * personalizados los crea quien tenga `role:manage`, si el plan lo incluye.
 *
 * Contra la escalada: un rol personalizado sólo puede incluir permisos que
 * quien lo crea o edita ya tiene, con igual o menor alcance. Y no se puede
 * editar un rol que ya exceda los propios (lo creó alguien con más permisos).
 */
@Injectable()
export class RolesService {
  constructor(
    private readonly accessService: AccessService,
    private readonly audit: AuditService,
  ) {}

  async list(): Promise<RolesView> {
    const { rows, limits } = await runInTenantTransaction(async (tx) => ({
      rows: await tx.role.findMany({ select: roleSelect }),
      limits: await loadPlanLimits(tx),
    }));
    rows.sort(
      (a, b) =>
        Number(b.isSystem) - Number(a.isSystem) ||
        (SYSTEM_ORDER[a.key] ?? 9) - (SYSTEM_ORDER[b.key] ?? 9) ||
        a.name.localeCompare(b.name, 'es', { sensitivity: 'base' }),
    );
    return { roles: rows.map(toView), customRolesEnabled: limits.customRoles };
  }

  async create(access: ResolvedAccess, input: RoleInput, req: Request): Promise<RoleView> {
    const permissions = this.grantable(access, input.permissions);

    const role = await runInTenantTransaction(async (tx) => {
      await lockTeam(tx, access.tenantId);
      await this.assertCustomRolesEnabled(tx);
      try {
        const created = await tx.role.create({
          data: {
            tenantId: access.tenantId,
            key: 'CUSTOM',
            name: input.name,
            description: input.description ?? null,
            isSystem: false,
          },
          select: { id: true },
        });
        await this.writePermissions(tx, access.tenantId, created.id, permissions);
        return tx.role.findUniqueOrThrow({ where: { id: created.id }, select: roleSelect });
      } catch (error) {
        throw duplicateName(error, input.name);
      }
    });

    await this.record(access, req, 'CREATE', role, {
      permisos: { antes: null, despues: permissions },
    });
    return toView(role);
  }

  async update(
    access: ResolvedAccess,
    roleId: string,
    input: RoleInput,
    req: Request,
  ): Promise<RoleView> {
    const permissions = this.grantable(access, input.permissions);

    const { before, after } = await runInTenantTransaction(async (tx) => {
      await lockTeam(tx, access.tenantId);
      const current = await this.editable(tx, access, roleId);
      try {
        await tx.role.update({
          where: { id: roleId },
          data: { name: input.name, description: input.description ?? null },
        });
      } catch (error) {
        throw duplicateName(error, input.name);
      }
      await tx.rolePermission.deleteMany({ where: { roleId } });
      await this.writePermissions(tx, access.tenantId, roleId, permissions);
      return {
        before: current,
        after: await tx.role.findUniqueOrThrow({ where: { id: roleId }, select: roleSelect }),
      };
    });

    // Afecta a todos los miembros con este rol, en su próxima petición.
    await this.accessService.invalidateTenant(access.tenantId);
    await this.record(access, req, 'UPDATE', after, {
      nombre: { antes: before.name, despues: after.name },
      permisos: { antes: permissionsOf(before), despues: permissions },
    });
    return toView(after);
  }

  async remove(access: ResolvedAccess, roleId: string, req: Request): Promise<void> {
    const role = await runInTenantTransaction(async (tx) => {
      await lockTeam(tx, access.tenantId);
      const current = await this.editable(tx, access, roleId);
      if (current._count.memberships > 0) {
        throw conflict(
          'El rol está en uso',
          `${current._count.memberships} miembro(s) lo tienen asignado. Cámbiales el rol antes de eliminarlo.`,
        );
      }
      await tx.role.delete({ where: { id: roleId } });
      return current;
    });
    await this.accessService.invalidateTenant(access.tenantId);
    await this.record(access, req, 'DELETE', role, {});
  }

  /* ------------------------------------------------------------------------ */

  private grantable(access: ResolvedAccess, requested: RoleInput['permissions']): PermissionMap {
    const permissions = normalizePermissionMap(requested);
    if (Object.keys(permissions).length === 0) {
      throw conflict('Elige al menos un permiso');
    }
    if (!canGrant(access.permissions, permissions)) {
      throw escalation('El rol incluye permisos, o alcances, que tú no tienes.');
    }
    return permissions;
  }

  private async editable(tx: TenantTransactionClient, access: ResolvedAccess, roleId: string) {
    const role = await tx.role.findUnique({ where: { id: roleId }, select: roleSelect });
    if (!role) throw notFound('Rol');
    if (role.isSystem) {
      throw conflict(
        'Los roles del sistema no se pueden modificar',
        'Crea un rol personalizado a partir de él.',
      );
    }
    if (!canGrant(access.permissions, permissionsOf(role))) {
      throw escalation('Este rol tiene permisos que tú no tienes: no puedes modificarlo.');
    }
    return role;
  }

  private async assertCustomRolesEnabled(tx: TenantTransactionClient): Promise<void> {
    const { customRoles } = await loadPlanLimits(tx);
    if (!customRoles) {
      throw featureUnavailable('Los roles personalizados están en los planes Pro y Business.');
    }
  }

  private async writePermissions(
    tx: TenantTransactionClient,
    tenantId: string,
    roleId: string,
    permissions: PermissionMap,
  ): Promise<void> {
    await tx.rolePermission.createMany({
      data: Object.entries(permissions).map(([permission, scope]) => ({
        tenantId,
        roleId,
        permission,
        scope,
      })),
    });
  }

  private record(
    access: ResolvedAccess,
    req: Request,
    action: 'CREATE' | 'UPDATE' | 'DELETE',
    role: RoleRow,
    changes: Record<string, unknown>,
  ): Promise<void> {
    return this.audit.record({
      tenantId: access.tenantId,
      actorUserId: access.userId,
      action,
      resourceType: 'Role',
      resourceId: role.id,
      resourceLabel: role.name,
      changes,
      ip: req.ip,
      userAgent: req.headers['user-agent']?.slice(0, 500),
      traceId: traceIdOf(req),
    });
  }
}

function permissionsOf(role: Pick<RoleRow, 'permissions'>): PermissionMap {
  return Object.fromEntries(role.permissions.map((p) => [p.permission, p.scope]));
}

function toView(role: RoleRow): RoleView {
  return {
    id: role.id,
    key: role.key,
    name: role.name,
    description: role.description,
    isSystem: role.isSystem,
    memberCount: role._count.memberships,
    permissions: permissionsOf(role),
  };
}

function duplicateName(error: unknown, name: string): unknown {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
    return conflict('Ya hay un rol con ese nombre', `Elige otro nombre distinto de «${name}».`);
  }
  return error;
}
