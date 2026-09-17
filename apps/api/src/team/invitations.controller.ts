import { Body, Controller, HttpCode, HttpStatus, Post, Req, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  acceptInvitationNewAccountSchema,
  type InvitationAccepted,
  type InvitationPreview,
  invitationTokenSchema,
  type SessionResponse,
} from '@nexo/contracts';
import type { Request, Response } from 'express';
import type { z } from 'zod';
import { type AuthenticatedRequest, Public } from '../auth/decorators';
import { InvitationAcceptanceService } from '../auth/invitation-acceptance.service';
import { hashPassword } from '../auth/password';
import { SessionService } from '../auth/session.service';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { DatabaseService } from '../database/database.service';
import { SkipMembershipCheck } from './access.decorators';

/**
 * Aceptar invitaciones. El token viaja SIEMPRE en el cuerpo, nunca en la URL
 * de la API: las URLs acaban en los registros de acceso.
 *
 * Tres caminos:
 *   · cuenta nueva      → `accept-new`: elige nombre y contraseña y entra.
 *   · sesión ya abierta → `accept`: con su token de acceso.
 *   · cuenta existente sin sesión → inicia sesión con `invitationToken` en
 *     /auth/login (funciona también con 2FA y si no tiene otras empresas).
 */
@ApiTags('Invitaciones')
@Controller('invitations')
export class InvitationsController {
  constructor(
    private readonly invitations: InvitationAcceptanceService,
    private readonly sessions: SessionService,
    private readonly db: DatabaseService,
  ) {}

  @Public()
  @Post('preview')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Ver a qué empresa y con qué rol invita un enlace' })
  preview(
    @Body(new ZodValidationPipe(invitationTokenSchema)) body: z.infer<typeof invitationTokenSchema>,
  ): Promise<InvitationPreview> {
    return this.invitations.preview(body.token);
  }

  @Public()
  @Post('accept-new')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Aceptar creando la cuenta: entra directamente en la empresa' })
  async acceptNew(
    @Body(new ZodValidationPipe(acceptInvitationNewAccountSchema))
    body: z.infer<typeof acceptInvitationNewAccountSchema>,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SessionResponse> {
    const { userId, accepted } = await this.invitations.acceptWithNewAccount(
      { token: body.token, name: body.name, passwordHash: await hashPassword(body.password) },
      req,
    );
    const user = await this.db.platform.user.findUniqueOrThrow({ where: { id: userId } });
    const { session, refreshToken } = await this.sessions.issue({
      user,
      req,
      tenantId: accepted.tenantId,
    });
    this.sessions.setRefreshCookie(res, refreshToken);
    return session;
  }

  @ApiBearerAuth()
  @SkipMembershipCheck()
  @Post('accept')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Aceptar con la sesión abierta de la cuenta invitada' })
  accept(
    @Body(new ZodValidationPipe(invitationTokenSchema)) body: z.infer<typeof invitationTokenSchema>,
    @Req() req: AuthenticatedRequest,
  ): Promise<InvitationAccepted> {
    return this.invitations.acceptBy(req.auth.sub, body.token, req);
  }
}
