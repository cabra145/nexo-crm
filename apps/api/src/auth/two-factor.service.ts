import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import {
  AUTH_PROBLEMS,
  BRAND,
  PROBLEM_TYPES,
  type ApiEnv,
  type TwoFactorEnabledResponse,
  type TwoFactorSetupResponse,
} from '@nexo/contracts';
import type { Request } from 'express';
import { decrypt, encrypt } from '../common/crypto/encryption';
import { ProblemException } from '../common/problem.exception';
import { API_ENV } from '../config/config.module';
import { DatabaseService } from '../database/database.service';
import { AuditService } from '../queues/audit.service';
import { twoFactorChangedEmail } from '../queues/mail-templates';
import { MailService } from '../queues/mail.service';
import { verifyPassword } from './password';
import { RateLimiterService } from './rate-limiter.service';
import { generateRecoveryCodes, hashRecoveryCode } from './recovery-codes';
import type { AccessTokenClaims } from './session.service';
import { SessionService } from './session.service';
import { generateTotpSecret, otpauthUrl, verifyTotp } from './totp';
import { traceIdOf } from '../common/trace-id';

@Injectable()
export class TwoFactorService {
  constructor(
    private readonly db: DatabaseService,
    private readonly sessions: SessionService,
    private readonly limiter: RateLimiterService,
    private readonly mail: MailService,
    private readonly audit: AuditService,
    @Inject(API_ENV) private readonly env: ApiEnv,
  ) {}

  /**
   * Genera un secreto nuevo SIN activarlo todavía. Queda pendiente hasta que
   * el usuario demuestre, con un código, que lo configuró bien en su
   * autenticador. Activarlo antes lo dejaría fuera de su cuenta.
   */
  async setup(auth: AccessTokenClaims): Promise<TwoFactorSetupResponse> {
    const user = await this.db.platform.user.findUniqueOrThrow({ where: { id: auth.sub } });
    if (user.totpEnabled) {
      throw new ProblemException({
        type: PROBLEM_TYPES.CONFLICT,
        title: 'Ya está activada',
        status: HttpStatus.CONFLICT,
        detail:
          'La verificación en dos pasos ya está activa. Desactívala primero si quieres cambiar de autenticador.',
      });
    }

    const secret = generateTotpSecret();
    await this.db.platform.totpSecret.upsert({
      where: { userId: user.id },
      create: { userId: user.id, secretEncrypted: encrypt(secret, this.env.ENCRYPTION_KEY) },
      update: { secretEncrypted: encrypt(secret, this.env.ENCRYPTION_KEY), confirmedAt: null },
    });

    return {
      secret,
      otpauthUrl: otpauthUrl({ secret, account: user.email, issuer: BRAND.fullName }),
    };
  }

  async enable(
    auth: AccessTokenClaims,
    code: string,
    req: Request,
  ): Promise<{ response: TwoFactorEnabledResponse; refreshToken: string }> {
    const user = await this.db.platform.user.findUniqueOrThrow({
      where: { id: auth.sub },
      include: { totp: true },
    });
    if (user.totpEnabled) {
      throw new ProblemException({
        type: PROBLEM_TYPES.CONFLICT,
        title: 'Ya está activada',
        status: HttpStatus.CONFLICT,
      });
    }
    if (!user.totp) {
      throw new ProblemException({
        type: PROBLEM_TYPES.VALIDATION,
        title: 'Falta configurar el autenticador',
        status: HttpStatus.BAD_REQUEST,
        detail: 'Empieza por escanear el código QR.',
      });
    }

    await this.assertAttempts(user.id);
    const step = verifyTotp(decrypt(user.totp.secretEncrypted, this.env.ENCRYPTION_KEY), code);
    if (step === null || !(await this.limiter.claimOnce('totp-step', `${user.id}:${step}`, 120))) {
      throw invalidCode();
    }

    const recoveryCodes = generateRecoveryCodes();
    const updated = await this.db.platform.$transaction(async (tx) => {
      await tx.totpSecret.update({ where: { userId: user.id }, data: { confirmedAt: new Date() } });
      return tx.user.update({
        where: { id: user.id },
        data: { totpEnabled: true, recoveryCodes: recoveryCodes.map(hashRecoveryCode) },
      });
    });

    // Las demás sesiones se abrieron sin segundo factor: se cierran. La actual
    // se sustituye por una nueva, que ya no arrastra el aviso de 2FA pendiente.
    await this.sessions.revokeAllForUser(user.id, 'two_factor_enabled');
    const { session, refreshToken } = await this.sessions.issue({
      user: updated,
      req,
      tenantId: auth.tid,
    });

    await this.notify(updated.email, updated.name, true, auth, req);
    return { response: { recoveryCodes, session }, refreshToken };
  }

  async disable(
    auth: AccessTokenClaims,
    password: string,
    code: string,
    req: Request,
  ): Promise<void> {
    const user = await this.verifyStepUp(auth.sub, password, code);

    await this.db.platform.$transaction([
      this.db.platform.totpSecret.delete({ where: { userId: user.id } }),
      this.db.platform.user.update({
        where: { id: user.id },
        data: { totpEnabled: false, recoveryCodes: [] },
      }),
    ]);

    await this.notify(user.email, user.name, false, auth, req);
  }

  /**
   * Confirmación reforzada para acciones sensibles: contraseña Y código del
   * autenticador del usuario de la sesión. Con sólo uno de los dos, quien
   * tenga una sesión abierta ajena podría quitar la protección de la cuenta o
   * transferir la empresa.
   *
   * Exige 2FA activo: sin autenticador no hay segundo factor que pedir.
   */
  async verifyStepUp(userId: string, password: string, code: string) {
    const user = await this.db.platform.user.findUniqueOrThrow({
      where: { id: userId },
      include: { totp: true },
    });
    if (!user.totpEnabled || !user.totp) {
      throw new ProblemException({
        type: PROBLEM_TYPES.CONFLICT,
        title: 'La verificación en dos pasos no está activada',
        status: HttpStatus.CONFLICT,
        detail: 'Actívala en Seguridad antes de hacer esto.',
      });
    }

    await this.assertAttempts(user.id);
    const passwordOk = user.passwordHash
      ? await verifyPassword(password, user.passwordHash)
      : false;
    const step = verifyTotp(decrypt(user.totp.secretEncrypted, this.env.ENCRYPTION_KEY), code);
    if (
      !passwordOk ||
      step === null ||
      !(await this.limiter.claimOnce('totp-step', `${user.id}:${step}`, 120))
    ) {
      throw invalidCode('La contraseña o el código no son correctos.');
    }
    return user;
  }

  private async assertAttempts(userId: string): Promise<void> {
    const result = await this.limiter.consume('2fa-manage', userId, 10, 15 * 60);
    if (!result.allowed) {
      throw new ProblemException(
        {
          type: PROBLEM_TYPES.RATE_LIMITED,
          title: 'Demasiados intentos',
          status: HttpStatus.TOO_MANY_REQUESTS,
          detail: 'Espera unos minutos antes de volver a intentarlo.',
        },
        { 'Retry-After': String(result.retryAfter) },
      );
    }
  }

  private async notify(
    email: string,
    name: string,
    enabled: boolean,
    auth: AccessTokenClaims,
    req: Request,
  ): Promise<void> {
    await this.mail.send(email, twoFactorChangedEmail({ name, enabled }), {
      category: 'auth',
      tenantId: auth.tid,
      traceId: traceIdOf(req),
    });
    await this.audit.record({
      tenantId: auth.tid,
      actorUserId: auth.sub,
      actorEmail: email,
      action: enabled ? 'TWO_FACTOR_ENABLE' : 'TWO_FACTOR_DISABLE',
      resourceType: 'User',
      resourceId: auth.sub,
      resourceLabel: email,
      ip: req.ip,
      userAgent: req.headers['user-agent']?.slice(0, 500),
      traceId: traceIdOf(req),
    });
  }
}

function invalidCode(
  detail = 'El código no es válido o ya se usó. Espera al siguiente código del autenticador.',
): ProblemException {
  return new ProblemException({
    type: AUTH_PROBLEMS.TWO_FACTOR_INVALID,
    title: 'Código incorrecto',
    status: HttpStatus.UNAUTHORIZED,
    detail,
  });
}
