import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  disableTwoFactorSchema,
  emailOnlySchema,
  enableTwoFactorSchema,
  loginSchema,
  loginTwoFactorSchema,
  registerSchema,
  resetPasswordSchema,
  switchTenantSchema,
  verifyEmailSchema,
  type LoginResponse,
  type SessionResponse,
  type TwoFactorEnabledResponse,
  type TwoFactorSetupResponse,
} from '@nexo/contracts';
import type { Request, Response } from 'express';
import type { z } from 'zod';
import { SkipMembershipCheck } from '../team/access.decorators';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { DatabaseService } from '../database/database.service';
import { AuthService, SilentlyIgnored } from './auth.service';
import { CsrfGuard } from './csrf.guard';
import {
  AllowWhileTwoFactorPending,
  type AuthenticatedRequest,
  CurrentAuth,
  Public,
} from './decorators';
import { type AccessTokenClaims, SessionService } from './session.service';
import { TwoFactorService } from './two-factor.service';

const ACCEPTED = { message: 'Si los datos son correctos, recibirás un correo en unos minutos.' };

/** Las respuestas "aceptado" son idénticas pase lo que pase, incluido el límite de correos. */
async function acceptedRegardless(work: () => Promise<void>): Promise<typeof ACCEPTED> {
  try {
    await work();
  } catch (error) {
    if (!(error instanceof SilentlyIgnored)) throw error;
  }
  return ACCEPTED;
}

@ApiTags('Autenticación')
// Todas estas rutas actúan sobre el USUARIO (su sesión, su 2FA, su cambio de
// empresa), no sobre la empresa del token: no exigen seguir siendo miembro.
@SkipMembershipCheck()
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly sessions: SessionService,
    private readonly twoFactor: TwoFactorService,
    private readonly db: DatabaseService,
  ) {}

  /* --- Alta ---------------------------------------------------------------- */

  @Public()
  @Post('register')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: 'Registrar una empresa con su propietario' })
  register(
    @Body(new ZodValidationPipe(registerSchema)) body: z.infer<typeof registerSchema>,
    @Req() req: Request,
  ) {
    return acceptedRegardless(() => this.auth.register(body, req));
  }

  @Public()
  @Post('verify-email')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Confirmar el correo con el enlace recibido' })
  async verifyEmail(
    @Body(new ZodValidationPipe(verifyEmailSchema)) body: z.infer<typeof verifyEmailSchema>,
  ) {
    await this.auth.verifyEmail(body.token);
    return { message: 'Correo confirmado. Ya puedes iniciar sesión.' };
  }

  @Public()
  @Post('verify-email/resend')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: 'Reenviar el correo de confirmación' })
  resendVerification(
    @Body(new ZodValidationPipe(emailOnlySchema)) body: z.infer<typeof emailOnlySchema>,
    @Req() req: Request,
  ) {
    return acceptedRegardless(() => this.auth.resendVerification(body.email, req));
  }

  /* --- Sesión -------------------------------------------------------------- */

  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Iniciar sesión (puede pedir segundo factor)' })
  async login(
    @Body(new ZodValidationPipe(loginSchema)) body: z.infer<typeof loginSchema>,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<LoginResponse> {
    const { response, refreshToken } = await this.auth.login(body, req);
    if (refreshToken) this.sessions.setRefreshCookie(res, refreshToken);
    return response;
  }

  @Public()
  @Post('login/2fa')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Completar el inicio de sesión con el segundo factor' })
  async loginTwoFactor(
    @Body(new ZodValidationPipe(loginTwoFactorSchema)) body: z.infer<typeof loginTwoFactorSchema>,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SessionResponse> {
    const { response, refreshToken } = await this.auth.loginWithTwoFactor(body, req);
    this.sessions.setRefreshCookie(res, refreshToken);
    return response;
  }

  @Public()
  @UseGuards(CsrfGuard)
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Renovar la sesión con la cookie de refresco' })
  async refresh(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SessionResponse> {
    const token = this.sessions.readRefreshCookie(req);
    try {
      // Sin cookie, `rotate` no encuentra el token y responde "sesión caducada".
      const { session, refreshToken } = await this.sessions.rotate(token ?? '', req);
      this.sessions.setRefreshCookie(res, refreshToken);
      return session;
    } catch (error) {
      // Una cookie que ya no sirve se borra: el navegador no debe insistir con ella.
      this.sessions.clearRefreshCookie(res);
      throw error;
    }
  }

  @UseGuards(CsrfGuard)
  @ApiBearerAuth()
  @Post('switch-tenant')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Cambiar de empresa activa' })
  async switchTenant(
    @CurrentAuth() auth: AccessTokenClaims,
    @Body(new ZodValidationPipe(switchTenantSchema)) body: z.infer<typeof switchTenantSchema>,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SessionResponse> {
    const token = this.sessions.readRefreshCookie(req);
    const { session, refreshToken } = await this.sessions.rotate(token ?? '', req, {
      tenantId: body.tenantId,
      expectedUserId: auth.sub,
    });
    this.sessions.setRefreshCookie(res, refreshToken);
    return session;
  }

  @Public()
  @UseGuards(CsrfGuard)
  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Cerrar esta sesión' })
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<void> {
    const token = this.sessions.readRefreshCookie(req);
    const familyId = token ? await this.sessions.familyOf(token) : null;
    if (familyId) await this.sessions.revokeFamily(familyId, 'logout');
    this.sessions.clearRefreshCookie(res);
  }

  @UseGuards(CsrfGuard)
  @ApiBearerAuth()
  @AllowWhileTwoFactorPending()
  @Post('logout-all')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Cerrar todas las sesiones del usuario' })
  async logoutAll(
    @CurrentAuth() auth: AccessTokenClaims,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    await this.sessions.revokeAllForUser(auth.sub, 'logout_all');
    this.sessions.clearRefreshCookie(res);
  }

  @ApiBearerAuth()
  @AllowWhileTwoFactorPending()
  @Get('me')
  @ApiOperation({ summary: 'Usuario, empresas y estado del 2FA de la sesión actual' })
  async me(@CurrentAuth() auth: AccessTokenClaims) {
    const user = await this.db.platform.user.findUniqueOrThrow({ where: { id: auth.sub } });
    const memberships = await this.sessions.usableMemberships(user.id);
    const active = memberships.find((m) => m.id === auth.mid);
    return {
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        avatarUrl: user.avatarUrl,
        twoFactorEnabled: user.totpEnabled,
      },
      activeTenant: active ? this.sessions.toSessionMembership(active) : null,
      memberships: memberships.map((m) => this.sessions.toSessionMembership(m)),
      twoFactor: active ? this.sessions.twoFactorRequirement(active, user) : null,
    };
  }

  /* --- Contraseña ---------------------------------------------------------- */

  @Public()
  @Post('password/forgot')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: 'Pedir el enlace para restablecer la contraseña' })
  forgotPassword(
    @Body(new ZodValidationPipe(emailOnlySchema)) body: z.infer<typeof emailOnlySchema>,
    @Req() req: Request,
  ) {
    return acceptedRegardless(() => this.auth.forgotPassword(body.email, req));
  }

  @Public()
  @Post('password/reset')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Elegir una contraseña nueva con el enlace recibido' })
  async resetPassword(
    @Body(new ZodValidationPipe(resetPasswordSchema)) body: z.infer<typeof resetPasswordSchema>,
    @Req() req: Request,
  ) {
    await this.auth.resetPassword(body.token, body.password, req);
    return { message: 'Contraseña actualizada. Inicia sesión con la nueva.' };
  }

  /* --- Verificación en dos pasos ------------------------------------------ */

  @ApiBearerAuth()
  @AllowWhileTwoFactorPending()
  @Post('2fa/setup')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Generar el secreto y el código QR del autenticador' })
  setupTwoFactor(@CurrentAuth() auth: AccessTokenClaims): Promise<TwoFactorSetupResponse> {
    return this.twoFactor.setup(auth);
  }

  @UseGuards(CsrfGuard)
  @ApiBearerAuth()
  @AllowWhileTwoFactorPending()
  @Post('2fa/enable')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Activar el 2FA con el primer código del autenticador' })
  async enableTwoFactor(
    @CurrentAuth() auth: AccessTokenClaims,
    @Body(new ZodValidationPipe(enableTwoFactorSchema)) body: z.infer<typeof enableTwoFactorSchema>,
    @Req() req: AuthenticatedRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<TwoFactorEnabledResponse> {
    const { response, refreshToken } = await this.twoFactor.enable(auth, body.code, req);
    this.sessions.setRefreshCookie(res, refreshToken);
    return response;
  }

  @ApiBearerAuth()
  @Post('2fa/disable')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Desactivar el 2FA (pide contraseña y código)' })
  disableTwoFactor(
    @CurrentAuth() auth: AccessTokenClaims,
    @Body(new ZodValidationPipe(disableTwoFactorSchema))
    body: z.infer<typeof disableTwoFactorSchema>,
    @Req() req: Request,
  ): Promise<void> {
    return this.twoFactor.disable(auth, body.password, body.code, req);
  }
}
