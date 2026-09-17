import { Injectable } from '@nestjs/common';
import {
  canGrant,
  type InviteMemberInput,
  type MemberView,
  type PermissionMap,
  TEAM_PROBLEMS,
  TEAM_TIMINGS,
  type TeamView,
  type TransferOwnershipInput,
  type UpdateMemberInput,
} from '@nexo/contracts';
import { Prisma, runInTenantTransaction, type TenantTransactionClient } from '@nexo/database';
import type { Request } from 'express';
import { EmailTokensService } from '../auth/email-tokens.service';
import { RateLimiterService } from '../auth/rate-limiter.service';
import { TwoFactorService } from '../auth/two-factor.service';
import { traceIdOf } from '../common/trace-id';
import { DatabaseService } from '../database/database.service';
import { type AuditEvent, AuditService } from '../queues/audit.service';
import { invitationEmail } from '../queues/mail-templates';
import { MailService } from '../queues/mail.service';
import type { ResolvedAccess } from './access.service';
import { AccessService } from './access.service';
import { loadPlanLimits, lockTeam } from './plan-limits';
import {
  conflict,
  escalation,
  notFound,
  ownerProtected,
  seatLimit,
  selfChange,
} from './team.problems';

const memberSelect = {
  id: true,
  userId: true,
  status: true,
  teamName: true,
  invitedAt: true,
  acceptedAt: true,
  role: {
    select: {
      id: true,
      key: true,
      name: true,
      permissions: { select: { permission: true, scope: true } },
    },
  },
  user: {
    select: { name: true, email: true, totpEnabled: true, lastLoginAt: true, passwordHash: true },
  },
} satisfies Prisma.MembershipSelect;

type MemberRow = Prisma.MembershipGetPayload<{ select: typeof memberSelect }>;

const permissionsOf = (role: { permissions: Array<{ permission: string; scope: string }> }) =>
  Object.fromEntries(role.permissions.map((p) => [p.permission, p.scope])) as PermissionMap;

/** Mismo límite de correos por dirección que la autenticación: 3 por hora. */
const EMAILS_PER_ADDRESS = { max: 3, windowSeconds: 60 * 60 };

/**
 * Miembros e invitaciones de la empresa activa.
 *
 * Reglas que se aplican aquí, además del permiso de la ruta:
 *
 *   · Nadie cambia su propio acceso (rol, desactivación, baja).
 *   · El propietario no se toca desde aquí: sólo cambia con la transferencia.
 *     Tampoco se puede asignar ni invitar como propietario.
 *   · Contra la escalada: sólo se puede asignar, o actuar sobre, un rol cuyos
 *     permisos estén todos dentro de los propios (con igual o menor alcance).
 *   · Plazas del plan: activos + invitaciones pendientes. Se comprueban con la
 *     empresa bloqueada, así que dos invitaciones simultáneas no las rebasan.
 *
 * Todo cambio invalida la caché de permisos de la empresa y queda auditado.
 */
@Injectable()
export class MembersService {
  constructor(
    private readonly db: DatabaseService,
    private readonly accessService: AccessService,
    private readonly tokens: EmailTokensService,
    private readonly limiter: RateLimiterService,
    private readonly twoFactor: TwoFactorService,
    private readonly mail: MailService,
    private readonly audit: AuditService,
  ) {}

  /* ======================================================================== */
  /*  Lectura                                                                  */
  /* ======================================================================== */

  async team(): Promise<TeamView> {
    const { rows, limits } = await runInTenantTransaction(async (tx) => ({
      rows: await tx.membership.findMany({ select: memberSelect }),
      limits: await loadPlanLimits(tx),
    }));

    const expiry = await this.tokens.pendingInvitationExpiry(
      rows.filter((r) => r.status === 'INVITED').map((r) => r.id),
    );
    const members = rows.map((r) => toView(r, expiry.get(r.id) ?? null));

    const order = { ACTIVE: 0, DISABLED: 1, INVITED: 2 } as const;
    members.sort(
      (a, b) =>
        order[a.status] - order[b.status] ||
        a.name.localeCompare(b.name, 'es', { sensitivity: 'base' }),
    );

    return {
      members,
      seats: { used: countSeats(rows), limit: limits.maxUsers },
    };
  }

  /* ======================================================================== */
  /*  Invitaciones                                                             */
  /* ======================================================================== */

  async invite(
    access: ResolvedAccess,
    input: InviteMemberInput,
    req: Request,
  ): Promise<MemberView> {
    const email = input.email;

    // La cuenta se busca (o se crea sin contraseña) FUERA de la transacción de
    // la empresa: `user` es de plataforma. Si la invitación no llega a
    // crearse, una cuenta creada aquí se borra.
    let user = await this.db.platform.user.findUnique({ where: { email } });
    if (user?.deletedAt || user?.status === 'DISABLED') {
      throw conflict('No se puede invitar a este correo', 'La cuenta está desactivada.');
    }
    let createdUser = false;
    if (!user) {
      try {
        user = await this.db.platform.user.create({
          data: { email, name: email.split('@')[0]!.slice(0, 120), status: 'PENDING_VERIFICATION' },
        });
        createdUser = true;
      } catch (error) {
        // Otra invitación a la misma dirección la creó entre medias.
        if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')) {
          throw error;
        }
        user = await this.db.platform.user.findUniqueOrThrow({ where: { email } });
      }
    }
    const invitee = user;

    let membershipId: string;
    let roleName: string;
    let tenantName: string;
    try {
      ({ membershipId, roleName, tenantName } = await runInTenantTransaction(async (tx) => {
        await lockTeam(tx, access.tenantId);
        const role = await this.assignableRole(tx, access, input.roleId);

        const existing = await tx.membership.findUnique({
          where: { tenantId_userId: { tenantId: access.tenantId, userId: invitee.id } },
          select: memberSelect,
        });
        // Reinvitar cambia el rol de la invitación pendiente: mismas reglas que
        // actuar sobre un miembro.
        if (existing?.status === 'INVITED') this.assertCanActOn(access, existing);
        if (existing && existing.status !== 'INVITED') {
          throw conflict(
            'Ya forma parte del equipo',
            existing.status === 'DISABLED'
              ? 'Está desactivado: reactívalo en lugar de invitarlo.'
              : undefined,
            TEAM_PROBLEMS.ALREADY_MEMBER,
          );
        }

        // Reinvitar a alguien pendiente no ocupa una plaza más.
        if (!existing) await this.assertSeatAvailable(tx);

        const membership = existing
          ? await tx.membership.update({
              where: { id: existing.id },
              data: {
                roleId: role.id,
                teamName: input.teamName ?? null,
                invitedByUserId: access.userId,
                invitedAt: new Date(),
              },
            })
          : await tx.membership.create({
              data: {
                tenantId: access.tenantId,
                userId: invitee.id,
                roleId: role.id,
                status: 'INVITED',
                teamName: input.teamName ?? null,
                invitedByUserId: access.userId,
              },
            });

        const tenant = await tx.tenant.findUniqueOrThrow({
          where: { id: access.tenantId },
          select: { name: true },
        });
        return { membershipId: membership.id, roleName: role.name, tenantName: tenant.name };
      }));
    } catch (error) {
      if (createdUser) {
        await this.db.platform.user.delete({ where: { id: invitee.id } }).catch(() => undefined);
      }
      throw error;
    }

    await this.sendInvitation({
      access,
      userId: invitee.id,
      email,
      membershipId,
      roleName,
      tenantName,
      accountExists: Boolean(invitee.passwordHash),
      req,
    });
    await this.record(access, req, {
      action: 'INVITE',
      resourceType: 'Membership',
      resourceId: membershipId,
      resourceLabel: email,
      changes: { rol: { antes: null, despues: roleName } },
    });

    return this.memberView(membershipId);
  }

  async resendInvitation(
    access: ResolvedAccess,
    membershipId: string,
    req: Request,
  ): Promise<MemberView> {
    const target = await runInTenantTransaction((tx) => this.findTarget(tx, membershipId));
    if (target.status !== 'INVITED') throw conflict('La invitación ya se aceptó');
    this.assertCanActOn(access, target, { allowSelf: false });

    const limit = await this.limiter.consume(
      'email-send',
      target.user.email,
      EMAILS_PER_ADDRESS.max,
      EMAILS_PER_ADDRESS.windowSeconds,
    );
    if (!limit.allowed) {
      throw conflict(
        'Ya se enviaron varias invitaciones a este correo',
        'Espera un rato antes de reenviarla: así evitamos que acabe en spam.',
      );
    }

    const tenantName = await runInTenantTransaction(
      async (tx) =>
        (
          await tx.tenant.findUniqueOrThrow({
            where: { id: access.tenantId },
            select: { name: true },
          })
        ).name,
    );
    await this.sendInvitation({
      access,
      userId: target.userId,
      email: target.user.email,
      membershipId,
      roleName: target.role.name,
      tenantName,
      accountExists: Boolean(target.user.passwordHash),
      req,
    });
    return this.memberView(membershipId);
  }

  private async sendInvitation(p: {
    access: ResolvedAccess;
    userId: string;
    email: string;
    membershipId: string;
    roleName: string;
    tenantName: string;
    accountExists: boolean;
    req: Request;
  }): Promise<void> {
    const { token } = await this.tokens.createInvitation(
      p.userId,
      { tenantId: p.access.tenantId, membershipId: p.membershipId },
      TEAM_TIMINGS.invitationDays * 86_400_000,
    );
    const inviter = await this.db.platform.user.findUnique({
      where: { id: p.access.userId },
      select: { name: true },
    });
    await this.mail.send(
      p.email,
      invitationEmail({
        inviterName: inviter?.name ?? null,
        tenantName: p.tenantName,
        roleName: p.roleName,
        url: this.mail.webUrl('/invitacion', { token }),
        days: TEAM_TIMINGS.invitationDays,
        accountExists: p.accountExists,
      }),
      { category: 'invitation', tenantId: p.access.tenantId, traceId: traceIdOf(p.req) },
    );
  }

  /* ======================================================================== */
  /*  Cambios sobre miembros                                                   */
  /* ======================================================================== */

  async update(
    access: ResolvedAccess,
    membershipId: string,
    input: UpdateMemberInput,
    req: Request,
  ): Promise<MemberView> {
    const changes: Record<string, { antes: unknown; despues: unknown }> = {};
    const label = await runInTenantTransaction(async (tx) => {
      await lockTeam(tx, access.tenantId);
      const target = await this.findTarget(tx, membershipId);
      this.assertCanActOn(access, target);

      const data: Prisma.MembershipUpdateInput = {};
      if (input.roleId !== undefined && input.roleId !== target.role.id) {
        const role = await this.assignableRole(tx, access, input.roleId);
        data.role = { connect: { id: role.id } };
        changes.rol = { antes: target.role.name, despues: role.name };
      }
      if (input.teamName !== undefined && input.teamName !== target.teamName) {
        data.teamName = input.teamName;
        changes.equipo = { antes: target.teamName, despues: input.teamName };
      }
      if (Object.keys(data).length > 0) {
        await tx.membership.update({ where: { id: target.id }, data });
      }
      return target.user.email;
    });

    if (Object.keys(changes).length > 0) {
      await this.accessService.invalidateTenant(access.tenantId);
      await this.record(access, req, {
        action: changes.rol ? 'ROLE_CHANGE' : 'UPDATE',
        resourceType: 'Membership',
        resourceId: membershipId,
        resourceLabel: label,
        changes,
      });
    }
    return this.memberView(membershipId);
  }

  async setDisabled(
    access: ResolvedAccess,
    membershipId: string,
    disabled: boolean,
    req: Request,
  ): Promise<MemberView> {
    const { email, changed } = await runInTenantTransaction(async (tx) => {
      await lockTeam(tx, access.tenantId);
      const target = await this.findTarget(tx, membershipId);
      this.assertCanActOn(access, target);
      if (target.status === 'INVITED') {
        throw conflict('La invitación está pendiente', 'Cancélala en lugar de desactivarla.');
      }
      const wanted = disabled ? 'DISABLED' : 'ACTIVE';
      if (target.status === wanted) return { email: target.user.email, changed: false };

      // Reactivar vuelve a ocupar una plaza.
      if (!disabled) await this.assertSeatAvailable(tx);

      await tx.membership.update({
        where: { id: target.id },
        data: { status: wanted, disabledAt: disabled ? new Date() : null },
      });
      return { email: target.user.email, changed: true };
    });

    if (changed) {
      await this.accessService.invalidateTenant(access.tenantId);
      await this.record(access, req, {
        action: 'UPDATE',
        resourceType: 'Membership',
        resourceId: membershipId,
        resourceLabel: email,
        changes: {
          estado: {
            antes: disabled ? 'ACTIVE' : 'DISABLED',
            despues: disabled ? 'DISABLED' : 'ACTIVE',
          },
        },
      });
    }
    return this.memberView(membershipId);
  }

  /**
   * Da de baja a un miembro (`member`) o cancela una invitación pendiente
   * (`invitation`). Son permisos distintos, así que cada ruta sólo actúa sobre
   * lo suyo: quien sólo puede invitar no puede dar de baja a nadie.
   */
  async remove(
    access: ResolvedAccess,
    membershipId: string,
    kind: 'member' | 'invitation',
    req: Request,
  ): Promise<void> {
    const target = await runInTenantTransaction(async (tx) => {
      await lockTeam(tx, access.tenantId);
      const found = await this.findTarget(tx, membershipId);
      if ((found.status === 'INVITED') !== (kind === 'invitation')) {
        throw notFound(kind === 'invitation' ? 'Invitación' : 'Miembro');
      }
      this.assertCanActOn(access, found);
      await tx.membership.delete({ where: { id: found.id } });
      return found;
    });

    await this.tokens.revokeInvitations(membershipId);
    await this.accessService.invalidateTenant(access.tenantId);
    await this.record(access, req, {
      action: 'DELETE',
      resourceType: target.status === 'INVITED' ? 'Invitation' : 'Membership',
      resourceId: membershipId,
      resourceLabel: target.user.email,
      changes: { rol: { antes: target.role.name, despues: null } },
    });
  }

  /* ======================================================================== */
  /*  Transferir la propiedad                                                  */
  /* ======================================================================== */

  /**
   * El propietario pasa a ser Administrador y el elegido, Propietario.
   *
   * Es la única vía por la que cambia el propietario, y la más sensible del
   * equipo: exige contraseña y código del autenticador del propietario, y que
   * el nuevo propietario tenga ya el 2FA activo (su rol lo exige, y sin él
   * quedaría bloqueado al instante).
   */
  async transferOwnership(
    access: ResolvedAccess,
    input: TransferOwnershipInput,
    req: Request,
  ): Promise<void> {
    await this.twoFactor.verifyStepUp(access.userId, input.password, input.code);

    const target = await runInTenantTransaction(async (tx) => {
      await lockTeam(tx, access.tenantId);
      const found = await this.findTarget(tx, input.membershipId);
      if (found.id === access.membershipId) throw selfChange();
      if (found.status !== 'ACTIVE') {
        throw conflict('Sólo se puede transferir a un miembro activo');
      }
      if (!found.user.totpEnabled) {
        throw conflict(
          'La persona elegida no tiene la verificación en dos pasos',
          'El propietario la necesita: pídele que la active en Seguridad y vuelve a intentarlo.',
        );
      }

      // El rol del actor se relee con la empresa bloqueada: dos transferencias
      // cruzadas no pueden dejar dos propietarios, ni ninguno.
      const self = await this.findTarget(tx, access.membershipId);
      if (self.role.key !== 'OWNER') throw ownerProtected();

      const roles = await tx.role.findMany({
        where: { isSystem: true, key: { in: ['OWNER', 'ADMIN'] } },
        select: { id: true, key: true },
      });
      const ownerRole = roles.find((r) => r.key === 'OWNER');
      const adminRole = roles.find((r) => r.key === 'ADMIN');
      if (!ownerRole || !adminRole) throw new Error('Faltan los roles del sistema OWNER/ADMIN');

      await tx.membership.update({ where: { id: found.id }, data: { roleId: ownerRole.id } });
      await tx.membership.update({ where: { id: self.id }, data: { roleId: adminRole.id } });
      return found;
    });

    await this.accessService.invalidateTenant(access.tenantId);
    await this.record(access, req, {
      action: 'ROLE_CHANGE',
      resourceType: 'Membership',
      resourceId: target.id,
      resourceLabel: target.user.email,
      changes: {
        rol: { antes: target.role.name, despues: 'Propietario' },
        motivo: { antes: null, despues: 'transferencia de propiedad' },
      },
    });
    await this.record(access, req, {
      action: 'ROLE_CHANGE',
      resourceType: 'Membership',
      resourceId: access.membershipId,
      resourceLabel: 'propietario anterior',
      changes: {
        rol: { antes: 'Propietario', despues: 'Administrador' },
        motivo: { antes: null, despues: 'transferencia de propiedad' },
      },
    });
  }

  /* ======================================================================== */
  /*  Reglas                                                                   */
  /* ======================================================================== */

  private async findTarget(tx: TenantTransactionClient, membershipId: string): Promise<MemberRow> {
    const target = await tx.membership.findUnique({
      where: { id: membershipId },
      select: memberSelect,
    });
    // De otra empresa, la extensión y la RLS la hacen invisible: 404, igual
    // que si no existiera.
    if (!target) throw notFound('Miembro');
    return target;
  }

  private assertCanActOn(
    access: ResolvedAccess,
    target: MemberRow,
    { allowSelf = false }: { allowSelf?: boolean } = {},
  ): void {
    if (!allowSelf && target.id === access.membershipId) throw selfChange();
    if (target.role.key === 'OWNER') throw ownerProtected();
    if (!canGrant(access.permissions, permissionsOf(target.role))) {
      throw escalation(
        `${target.user.email} tiene un rol con permisos que tú no tienes: no puedes modificarlo.`,
      );
    }
  }

  private async assignableRole(
    tx: TenantTransactionClient,
    access: ResolvedAccess,
    roleId: string,
  ) {
    const role = await tx.role.findUnique({
      where: { id: roleId },
      select: {
        id: true,
        key: true,
        name: true,
        permissions: { select: { permission: true, scope: true } },
      },
    });
    if (!role) throw notFound('Rol');
    if (role.key === 'OWNER') throw ownerProtected();
    if (!canGrant(access.permissions, permissionsOf(role))) {
      throw escalation(`El rol «${role.name}» incluye permisos que tú no tienes.`);
    }
    return role;
  }

  private async assertSeatAvailable(tx: TenantTransactionClient): Promise<void> {
    const { maxUsers } = await loadPlanLimits(tx);
    if (maxUsers === null) return;
    const used = await tx.membership.count({ where: { status: { in: ['ACTIVE', 'INVITED'] } } });
    if (used >= maxUsers) throw seatLimit(maxUsers);
  }

  private async memberView(membershipId: string): Promise<MemberView> {
    const row = await runInTenantTransaction((tx) => this.findTarget(tx, membershipId));
    const expiry =
      row.status === 'INVITED'
        ? ((await this.tokens.pendingInvitationExpiry([row.id])).get(row.id) ?? null)
        : null;
    return toView(row, expiry);
  }

  private record(
    access: ResolvedAccess,
    req: Request,
    event: Omit<AuditEvent, 'tenantId' | 'actorUserId' | 'ip' | 'userAgent' | 'traceId'>,
  ): Promise<void> {
    return this.audit.record({
      tenantId: access.tenantId,
      actorUserId: access.userId,
      ip: req.ip,
      userAgent: req.headers['user-agent']?.slice(0, 500),
      traceId: traceIdOf(req),
      ...event,
    });
  }
}

function countSeats(rows: Array<{ status: string }>): number {
  return rows.filter((r) => r.status === 'ACTIVE' || r.status === 'INVITED').length;
}

function toView(row: MemberRow, invitationExpiresAt: Date | null): MemberView {
  return {
    membershipId: row.id,
    userId: row.userId,
    // Invitado sin cuenta: todavía no eligió nombre.
    name: row.status === 'INVITED' && !row.user.passwordHash ? row.user.email : row.user.name,
    email: row.user.email,
    status: row.status,
    role: { id: row.role.id, key: row.role.key, name: row.role.name },
    teamName: row.teamName,
    twoFactorEnabled: row.user.totpEnabled,
    invitedAt: row.invitedAt.toISOString(),
    acceptedAt: row.acceptedAt?.toISOString() ?? null,
    lastLoginAt: row.user.lastLoginAt?.toISOString() ?? null,
    invitationExpiresAt: invitationExpiresAt?.toISOString() ?? null,
  };
}
