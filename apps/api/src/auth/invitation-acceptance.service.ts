import { HttpStatus, Injectable } from '@nestjs/common';
import {
  AUTH_PROBLEMS,
  type InvitationAccepted,
  type InvitationPreview,
  TEAM_PROBLEMS,
} from '@nexo/contracts';
import { runInTenantTransaction, runWithTenantContext } from '@nexo/database';
import type { Request } from 'express';
import { ProblemException } from '../common/problem.exception';
import { traceIdOf } from '../common/trace-id';
import { DatabaseService } from '../database/database.service';
import { AuditService } from '../queues/audit.service';
import { EmailTokensService, type ValidInvitation } from './email-tokens.service';

const USABLE_TENANT_STATUSES = new Set(['TRIAL', 'ACTIVE', 'PAST_DUE']);

/**
 * Aceptar una invitación: el enlace del correo convierte una membresía
 * INVITED en ACTIVE.
 *
 * Vive en el módulo de autenticación porque también se acepta AL INICIAR
 * SESIÓN: quien ya tiene cuenta entra con su contraseña (y su 2FA) y la
 * invitación se canjea en ese mismo paso. Así funciona incluso para quien no
 * pertenece a ninguna otra empresa y, por tanto, no podría iniciar sesión
 * para aceptarla después.
 *
 * Lo que prueba el enlace es el control del BUZÓN; lo que prueba la contraseña
 * es la identidad. Para una cuenta existente se exigen los dos: el enlace
 * reenviado a otra persona no le sirve sin la contraseña de la cuenta invitada.
 */
@Injectable()
export class InvitationAcceptanceService {
  constructor(
    private readonly db: DatabaseService,
    private readonly tokens: EmailTokensService,
    private readonly audit: AuditService,
  ) {}

  /** Datos para la pantalla de la invitación. No canjea nada. */
  async preview(token: string): Promise<InvitationPreview> {
    const invitation = await this.tokens.peekInvitation(token);
    if (!invitation) throw invalidInvitation();

    const [user, details] = await Promise.all([
      this.db.platform.user.findUnique({ where: { id: invitation.userId } }),
      this.details(invitation),
    ]);
    if (!user || user.deletedAt || !details) throw invalidInvitation();

    const inviter = details.invitedByUserId
      ? await this.db.platform.user.findUnique({
          where: { id: details.invitedByUserId },
          select: { name: true },
        })
      : null;

    return {
      email: user.email,
      tenantName: details.tenantName,
      roleName: details.roleName,
      inviterName: inviter?.name ?? null,
      accountExists: Boolean(user.passwordHash),
      expiresAt: invitation.expiresAt.toISOString(),
    };
  }

  /**
   * Comprueba, SIN canjearla, que la invitación es válida y es de este
   * usuario. Se llama con la contraseña ya verificada: antes, los errores
   * distintos delatarían a quién pertenece un enlace.
   */
  async assertAcceptableBy(userId: string, token: string): Promise<ValidInvitation> {
    const invitation = await this.tokens.peekInvitation(token);
    if (!invitation || !(await this.details(invitation))) throw invalidInvitation();
    if (invitation.userId !== userId) throw emailMismatch();
    return invitation;
  }

  /** Canjea la invitación del usuario `userId` y activa su membresía. */
  async acceptBy(userId: string, token: string, req: Request): Promise<InvitationAccepted> {
    // Se comprueba el destinatario ANTES de canjear: un enlace abierto con la
    // cuenta equivocada no debe quedar gastado.
    await this.assertAcceptableBy(userId, token);
    const invitation = await this.tokens.consumeInvitation(token);
    if (!invitation || invitation.userId !== userId) throw invalidInvitation();
    return this.activate(invitation, req);
  }

  /**
   * Acepta la invitación creando la cuenta: el invitado aún no tenía
   * contraseña (la cuenta la creó la invitación). El enlace prueba el control
   * del buzón, así que el correo queda verificado.
   *
   * Devuelve el id del usuario, para emitir su sesión en la empresa.
   */
  async acceptWithNewAccount(
    input: { token: string; name: string; passwordHash: string },
    req: Request,
  ): Promise<{ userId: string; accepted: InvitationAccepted }> {
    const pending = await this.tokens.peekInvitation(input.token);
    if (!pending) throw invalidInvitation();
    const user = await this.db.platform.user.findUnique({ where: { id: pending.userId } });
    if (!user || user.deletedAt) throw invalidInvitation();
    if (user.passwordHash) throw accountExists();

    const invitation = await this.tokens.consumeInvitation(input.token);
    if (!invitation) throw invalidInvitation();
    const accepted = await this.activate(invitation, req);

    // Condicionado a que siga sin contraseña: si la misma persona se registró
    // por otra vía entre medias, no se le pisa la que eligió.
    const updated = await this.db.platform.user.updateMany({
      where: { id: invitation.userId, passwordHash: null },
      data: {
        name: input.name,
        passwordHash: input.passwordHash,
        status: 'ACTIVE',
        emailVerifiedAt: user.emailVerifiedAt ?? new Date(),
      },
    });
    if (updated.count === 0) throw accountExists();

    return { userId: invitation.userId, accepted };
  }

  private async activate(invitation: ValidInvitation, req: Request): Promise<InvitationAccepted> {
    const result = await runWithTenantContext(
      { tenantId: invitation.tenantId, userId: invitation.userId, actorType: 'USER' },
      () =>
        runInTenantTransaction(async (tx) => {
          const activated = await tx.membership.updateMany({
            where: { id: invitation.membershipId, userId: invitation.userId, status: 'INVITED' },
            data: { status: 'ACTIVE', acceptedAt: new Date() },
          });
          if (activated.count === 0) return null;
          const tenant = await tx.tenant.findUniqueOrThrow({
            where: { id: invitation.tenantId },
            select: { slug: true },
          });
          return { tenantId: invitation.tenantId, tenantSlug: tenant.slug };
        }),
    );
    if (!result) throw invalidInvitation();

    const user = await this.db.platform.user.findUniqueOrThrow({
      where: { id: invitation.userId },
      select: { email: true },
    });
    await this.audit.record({
      tenantId: invitation.tenantId,
      actorUserId: invitation.userId,
      actorEmail: user.email,
      action: 'UPDATE',
      resourceType: 'Membership',
      resourceId: invitation.membershipId,
      resourceLabel: user.email,
      changes: { status: { antes: 'INVITED', despues: 'ACTIVE' } },
      ip: req.ip,
      userAgent: req.headers['user-agent']?.slice(0, 500),
      traceId: traceIdOf(req),
    });
    return result;
  }

  /** Membresía invitada, en una empresa usable, con su rol. Null si ya no lo es. */
  private details(invitation: ValidInvitation) {
    return runWithTenantContext({ tenantId: invitation.tenantId, actorType: 'SYSTEM' }, () =>
      runInTenantTransaction(async (tx) => {
        const membership = await tx.membership.findUnique({
          where: { id: invitation.membershipId },
          select: {
            userId: true,
            status: true,
            invitedByUserId: true,
            role: { select: { name: true } },
            tenant: { select: { name: true, status: true, deletedAt: true } },
          },
        });
        if (
          !membership ||
          membership.status !== 'INVITED' ||
          membership.userId !== invitation.userId ||
          membership.tenant.deletedAt ||
          !USABLE_TENANT_STATUSES.has(membership.tenant.status)
        ) {
          return null;
        }
        return {
          tenantName: membership.tenant.name,
          roleName: membership.role.name,
          invitedByUserId: membership.invitedByUserId,
        };
      }),
    );
  }
}

export function invalidInvitation(): ProblemException {
  return new ProblemException({
    type: AUTH_PROBLEMS.TOKEN_INVALID,
    title: 'La invitación no es válida',
    status: HttpStatus.BAD_REQUEST,
    detail: 'El enlace caducó, ya se usó o la invitación se canceló. Pide una nueva.',
  });
}

function accountExists(): ProblemException {
  return new ProblemException({
    type: TEAM_PROBLEMS.ALREADY_MEMBER,
    title: 'Ya tienes una cuenta',
    status: HttpStatus.CONFLICT,
    detail: 'Este correo ya tiene cuenta: inicia sesión con ella para aceptar la invitación.',
  });
}

function emailMismatch(): ProblemException {
  return new ProblemException({
    type: TEAM_PROBLEMS.INVITATION_EMAIL_MISMATCH,
    title: 'La invitación es para otra cuenta',
    status: HttpStatus.FORBIDDEN,
    detail: 'Entra con la cuenta del correo al que llegó la invitación.',
  });
}
