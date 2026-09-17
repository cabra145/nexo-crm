import { randomUUID } from 'node:crypto';
import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import {
  AUTH_PROBLEMS,
  AUTH_TIMINGS,
  PROBLEM_TYPES,
  RESERVED_SLUGS,
  toSlug,
  type ApiEnv,
  type LoginInput,
  type LoginResponse,
  type RegisterInput,
  type SessionResponse,
} from '@nexo/contracts';
import { Prisma, runInNewTenantTransaction, type User } from '@nexo/database';
import type { Request } from 'express';
import { decrypt } from '../common/crypto/encryption';
import { ProblemException } from '../common/problem.exception';
import { API_ENV } from '../config/config.module';
import { DatabaseService } from '../database/database.service';
import { AuditService } from '../queues/audit.service';
import {
  accountAlreadyExistsEmail,
  passwordChangedEmail,
  passwordResetEmail,
  verificationEmail,
} from '../queues/mail-templates';
import { MailService } from '../queues/mail.service';
import { bootstrapTenant } from '../tenants/tenant-bootstrap';
import { EmailTokensService } from './email-tokens.service';
import { hashPassword, needsRehash, verifyPassword } from './password';
import { InvitationAcceptanceService } from './invitation-acceptance.service';
import { RateLimiterService } from './rate-limiter.service';
import { hashRecoveryCode } from './recovery-codes';
import { SessionService } from './session.service';
import { verifyTotp } from './totp';
import { traceIdOf } from '../common/trace-id';

interface TwoFactorChallengeClaims {
  typ: '2fa';
  sub: string;
  jti: string;
  tsl?: string;
  /** Invitación que se acepta al completar el inicio de sesión. */
  inv?: string;
}

/** Límites de intentos. */
const LIMITS = {
  loginFailuresPerAccount: { max: 5, windowSeconds: 15 * 60 },
  loginAttemptsPerIp: { max: 50, windowSeconds: 15 * 60 },
  twoFactorAttemptsPerChallenge: { max: 5 },
  emailsPerAddress: { max: 3, windowSeconds: 60 * 60 },
} as const;

@Injectable()
export class AuthService {
  private readonly logger = new Logger('Autenticación');

  /**
   * Hash de una contraseña que no existe, calculado una vez.
   *
   * Cuando se intenta entrar con un correo que no tiene cuenta, se verifica la
   * contraseña contra este hash igualmente. Sin eso, la respuesta a un correo
   * inexistente llegaría ~50 ms antes que a uno existente (no hay Argon2 que
   * calcular), y midiendo tiempos se podría averiguar qué correos tienen cuenta.
   */
  private dummyHash: Promise<string> = hashPassword(randomUUID());

  constructor(
    private readonly db: DatabaseService,
    private readonly sessions: SessionService,
    private readonly tokens: EmailTokensService,
    private readonly limiter: RateLimiterService,
    private readonly invitations: InvitationAcceptanceService,
    private readonly mail: MailService,
    private readonly audit: AuditService,
    private readonly jwt: JwtService,
    @Inject(API_ENV) private readonly env: ApiEnv,
  ) {}

  /* ======================================================================== */
  /*  Registro                                                                 */
  /* ======================================================================== */

  /**
   * Da de alta una empresa con su propietario.
   *
   * La respuesta es SIEMPRE la misma, exista o no el correo: si ya tiene
   * cuenta, se le avisa por correo en vez de por pantalla. Así el formulario
   * de registro no sirve para averiguar quién es cliente.
   */
  async register(input: RegisterInput, req: Request): Promise<void> {
    await this.assertEmailRateLimit(input.email);

    const existing = await this.db.platform.user.findUnique({ where: { email: input.email } });
    // Cuenta creada por una invitación que todavía no se aceptó: no tiene
    // contraseña y nadie la ha usado. Registrarse la completa en lugar de
    // responder «ya tienes cuenta»; la invitación sigue pendiente.
    if (existing && !existing.passwordHash && !existing.deletedAt) {
      return this.registerOverInvitedAccount(existing, input, req);
    }
    if (existing) {
      await this.mail.send(
        existing.email,
        accountAlreadyExistsEmail({
          name: existing.name,
          loginUrl: this.mail.webUrl('/login'),
          resetUrl: this.mail.webUrl('/recuperar'),
        }),
        { category: 'auth', traceId: traceIdOf(req) },
      );
      // Mismo coste que un alta real, para no delatarlo por tiempo.
      await hashPassword(input.password);
      return;
    }

    const plan = await this.db.platform.plan.findFirst({
      where: { isDefault: true, archivedAt: null },
    });
    if (!plan) {
      throw new Error(
        'No hay un plan por defecto (plan.is_default). El registro no puede continuar.',
      );
    }

    const passwordHash = await hashPassword(input.password);
    const user = await this.db.platform.user.create({
      data: {
        email: input.email,
        name: input.name,
        passwordHash,
        status: 'PENDING_VERIFICATION',
        locale: 'es',
      },
    });

    try {
      const tenantId = await this.createTenantWithUniqueSlug(input, user.id, plan);
      await this.audit.record({
        tenantId,
        actorUserId: user.id,
        actorEmail: user.email,
        action: 'CREATE',
        resourceType: 'Tenant',
        resourceId: tenantId,
        resourceLabel: input.companyName,
        ip: req.ip,
        userAgent: req.headers['user-agent']?.slice(0, 500),
        traceId: traceIdOf(req),
      });
    } catch (error) {
      // Sin empresa, el usuario no sirve para nada: no se deja a medias.
      await this.db.platform.user.delete({ where: { id: user.id } }).catch(() => undefined);
      throw error;
    }

    await this.sendVerification(user, traceIdOf(req));
  }

  private async registerOverInvitedAccount(
    invited: User,
    input: RegisterInput,
    req: Request,
  ): Promise<void> {
    const passwordHash = await hashPassword(input.password);
    const plan = await this.db.platform.plan.findFirst({
      where: { isDefault: true, archivedAt: null },
    });
    if (!plan) {
      throw new Error(
        'No hay un plan por defecto (plan.is_default). El registro no puede continuar.',
      );
    }
    const claimed = await this.db.platform.user.updateMany({
      where: { id: invited.id, passwordHash: null },
      data: { name: input.name, passwordHash },
    });
    // Otra petición completó la cuenta entre medias: mismo trato que una
    // cuenta existente (respuesta idéntica, sin alta).
    if (claimed.count === 0) return;

    let tenantId: string;
    try {
      tenantId = await this.createTenantWithUniqueSlug(input, invited.id, plan);
    } catch (error) {
      // Sin empresa no hay registro: la cuenta vuelve a quedar como la dejó
      // la invitación, para poder aceptarla o registrarse otra vez.
      await this.db.platform.user
        .updateMany({ where: { id: invited.id, passwordHash }, data: { passwordHash: null } })
        .catch(() => undefined);
      throw error;
    }
    await this.audit.record({
      tenantId,
      actorUserId: invited.id,
      actorEmail: invited.email,
      action: 'CREATE',
      resourceType: 'Tenant',
      resourceId: tenantId,
      resourceLabel: input.companyName,
      ip: req.ip,
      userAgent: req.headers['user-agent']?.slice(0, 500),
      traceId: traceIdOf(req),
    });
    await this.sendVerification({ ...invited, name: input.name }, traceIdOf(req));
  }

  private async createTenantWithUniqueSlug(
    input: RegisterInput,
    ownerUserId: string,
    plan: { id: string; trialDays: number },
  ): Promise<string> {
    const base = input.slug ?? slugify(input.companyName);

    // El slug es único, pero la RLS impide CONSULTAR si otra empresa lo usa. Así
    // que se intenta crear y, si la restricción única lo rechaza, se prueba con
    // un sufijo. Si el usuario eligió el slug, no se cambia: se le dice.
    for (let attempt = 0; attempt < 5; attempt++) {
      const slug = attempt === 0 ? base : `${base}-${randomUUID().slice(0, 4)}`;
      try {
        return await runInNewTenantTransaction(async (tx, tenantId) => {
          await tx.tenant.create({
            data: { id: tenantId, slug, name: input.companyName, status: 'TRIAL' },
          });
          await bootstrapTenant(tx, {
            tenantId,
            ownerUserId,
            planId: plan.id,
            trialDays: plan.trialDays,
          });
          return tenantId;
        });
      } catch (error) {
        const slugTaken =
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === 'P2002' &&
          JSON.stringify(error.meta?.target ?? '').includes('slug');
        if (!slugTaken) throw error;
        if (input.slug) {
          throw new ProblemException({
            type: PROBLEM_TYPES.CONFLICT,
            title: 'Dirección no disponible',
            status: HttpStatus.CONFLICT,
            detail: 'Esa dirección para tu espacio de trabajo ya está en uso. Elige otra.',
            errors: [{ field: 'slug', message: 'ya está en uso' }],
          });
        }
      }
    }
    throw new Error('No se encontró un slug libre tras 5 intentos');
  }

  /* ======================================================================== */
  /*  Verificación de correo                                                   */
  /* ======================================================================== */

  private async sendVerification(user: User, traceId?: string): Promise<void> {
    const token = await this.tokens.create(
      user.id,
      'EMAIL_VERIFICATION',
      AUTH_TIMINGS.emailVerificationHours * 3_600_000,
    );
    await this.mail.send(
      user.email,
      verificationEmail({
        name: user.name,
        url: this.mail.webUrl('/verificar-correo', { token }),
        hours: AUTH_TIMINGS.emailVerificationHours,
      }),
      { category: 'auth', traceId },
    );
  }

  async verifyEmail(token: string): Promise<void> {
    const userId = await this.tokens.consume(token, 'EMAIL_VERIFICATION');
    if (!userId) throw invalidLink();

    await this.db.platform.user.update({
      where: { id: userId },
      data: { status: 'ACTIVE', emailVerifiedAt: new Date() },
    });
  }

  /** Reenvía la verificación. Misma respuesta exista o no la cuenta. */
  async resendVerification(email: string, req: Request): Promise<void> {
    await this.assertEmailRateLimit(email);
    const user = await this.db.platform.user.findUnique({ where: { email } });
    if (user && user.status === 'PENDING_VERIFICATION' && !user.deletedAt) {
      await this.sendVerification(user, traceIdOf(req));
    }
  }

  /* ======================================================================== */
  /*  Inicio de sesión                                                         */
  /* ======================================================================== */

  async login(
    input: LoginInput,
    req: Request,
  ): Promise<{ response: LoginResponse; refreshToken?: string }> {
    const ip = req.ip ?? 'desconocida';
    const accountKey = `${ip}|${input.email}`;

    const perIp = await this.limiter.consume(
      'login-ip',
      ip,
      LIMITS.loginAttemptsPerIp.max,
      LIMITS.loginAttemptsPerIp.windowSeconds,
    );
    const perAccount = await this.limiter.isBlocked(
      'login-fail',
      accountKey,
      LIMITS.loginFailuresPerAccount.max,
    );
    if (!perIp.allowed || !perAccount.allowed) {
      throw tooManyAttempts(Math.max(perIp.retryAfter, perAccount.retryAfter));
    }

    const user = await this.db.platform.user.findUnique({ where: { email: input.email } });
    const passwordOk = await verifyPassword(
      input.password,
      user?.passwordHash ?? (await this.dummyHash),
    );

    if (!user || !user.passwordHash || user.deletedAt || !passwordOk) {
      await this.limiter.hit(
        'login-fail',
        accountKey,
        LIMITS.loginFailuresPerAccount.windowSeconds,
      );
      if (user) {
        await this.db.platform.user.update({
          where: { id: user.id },
          data: { failedLoginAttempts: { increment: 1 } },
        });
      }
      throw new ProblemException({
        type: AUTH_PROBLEMS.INVALID_CREDENTIALS,
        title: 'Correo o contraseña incorrectos',
        status: HttpStatus.UNAUTHORIZED,
        detail: 'Revisa el correo y la contraseña e inténtalo de nuevo.',
      });
    }

    await this.limiter.reset('login-fail', accountKey);

    // A partir de aquí la contraseña es correcta: estos errores sólo los ve
    // quien la conoce, así que ya no revelan nada a un atacante.
    if (user.status === 'PENDING_VERIFICATION') {
      throw new ProblemException({
        type: AUTH_PROBLEMS.EMAIL_NOT_VERIFIED,
        title: 'Confirma tu correo',
        status: HttpStatus.FORBIDDEN,
        detail: 'Antes de entrar tienes que confirmar tu correo con el enlace que te enviamos.',
      });
    }
    if (user.status === 'DISABLED') {
      throw new ProblemException({
        type: AUTH_PROBLEMS.ACCOUNT_DISABLED,
        title: 'Cuenta desactivada',
        status: HttpStatus.FORBIDDEN,
        detail: 'Tu cuenta está desactivada. Habla con el administrador de tu empresa.',
      });
    }

    // Parámetros de Argon2 endurecidos desde que se creó el hash: se actualiza
    // ahora, que tenemos la contraseña en claro.
    if (needsRehash(user.passwordHash)) {
      await this.db.platform.user.update({
        where: { id: user.id },
        data: { passwordHash: await hashPassword(input.password) },
      });
    }

    // Inicio de sesión para aceptar una invitación: se comprueba ya, con la
    // contraseña verificada, para no pedir el segundo factor en balde.
    if (input.invitationToken) {
      await this.invitations.assertAcceptableBy(user.id, input.invitationToken);
    }

    if (user.totpEnabled) {
      const challengeToken = await this.jwt.signAsync(
        {
          typ: '2fa',
          sub: user.id,
          jti: randomUUID(),
          tsl: input.tenantSlug,
          inv: input.invitationToken,
        } satisfies TwoFactorChallengeClaims,
        {
          secret: this.env.JWT_REFRESH_SECRET,
          expiresIn: AUTH_TIMINGS.twoFactorChallengeMinutes * 60,
          algorithm: 'HS256',
        },
      );
      return {
        response: {
          requiresTwoFactor: true,
          challengeToken,
          expiresIn: AUTH_TIMINGS.twoFactorChallengeMinutes * 60,
        },
      };
    }

    return this.completeLogin(user, req, input.tenantSlug, input.invitationToken);
  }

  /** Segundo paso: código del autenticador o código de recuperación. */
  async loginWithTwoFactor(
    input: { challengeToken: string; code?: string; recoveryCode?: string },
    req: Request,
  ): Promise<{ response: SessionResponse; refreshToken: string }> {
    let claims: TwoFactorChallengeClaims;
    try {
      claims = await this.jwt.verifyAsync<TwoFactorChallengeClaims>(input.challengeToken, {
        secret: this.env.JWT_REFRESH_SECRET,
        algorithms: ['HS256'],
      });
      if (claims.typ !== '2fa') throw new Error('tipo incorrecto');
    } catch {
      throw new ProblemException({
        type: AUTH_PROBLEMS.SESSION_EXPIRED,
        title: 'El inicio de sesión caducó',
        status: HttpStatus.UNAUTHORIZED,
        detail: 'Pasó demasiado tiempo desde que escribiste la contraseña. Vuelve a empezar.',
      });
    }

    const attempts = await this.limiter.consume(
      '2fa-challenge',
      claims.jti,
      LIMITS.twoFactorAttemptsPerChallenge.max,
      AUTH_TIMINGS.twoFactorChallengeMinutes * 60,
    );
    if (!attempts.allowed) throw tooManyAttempts(attempts.retryAfter);

    const user = await this.db.platform.user.findUnique({
      where: { id: claims.sub },
      include: { totp: true },
    });
    if (!user || user.status !== 'ACTIVE' || !user.totpEnabled || !user.totp?.confirmedAt) {
      throw invalidTwoFactor();
    }

    if (input.code) {
      const step = verifyTotp(
        decrypt(user.totp.secretEncrypted, this.env.ENCRYPTION_KEY),
        input.code,
      );
      // Cada intervalo de 30 s sirve una sola vez: un código visto por encima
      // del hombro no se puede reutilizar mientras sigue siendo válido.
      if (
        step === null ||
        !(await this.limiter.claimOnce('totp-step', `${user.id}:${step}`, 120))
      ) {
        throw invalidTwoFactor();
      }
    } else if (input.recoveryCode) {
      const hash = hashRecoveryCode(input.recoveryCode);
      // Consumo atómico: el código sale del array en la misma sentencia que
      // comprueba que estaba. Dos usos simultáneos no pueden pasar los dos.
      const consumed = await this.db.platform.$executeRaw`
        UPDATE "user" SET recovery_codes = array_remove(recovery_codes, ${hash}), updated_at = now()
         WHERE id = ${user.id}::uuid AND ${hash} = ANY(recovery_codes)
      `;
      if (consumed === 0) throw invalidTwoFactor();
      this.logger.log(`Código de recuperación usado por el usuario ${user.id}`);
    }

    // El desafío deja de valer: la contraseña no se puede reutilizar para un
    // segundo inicio de sesión con el mismo token.
    if (
      !(await this.limiter.claimOnce(
        '2fa-challenge-used',
        claims.jti,
        AUTH_TIMINGS.twoFactorChallengeMinutes * 60,
      ))
    ) {
      throw invalidTwoFactor();
    }

    const { response, refreshToken } = await this.completeLogin(user, req, claims.tsl, claims.inv);
    return { response: response as SessionResponse, refreshToken: refreshToken! };
  }

  private async completeLogin(
    user: User,
    req: Request,
    tenantSlug?: string,
    invitationToken?: string,
  ): Promise<{ response: LoginResponse; refreshToken?: string }> {
    // Con invitación, se entra directamente en la empresa que invita.
    const accepted = invitationToken
      ? await this.invitations.acceptBy(user.id, invitationToken, req)
      : null;
    const { session, refreshToken } = await this.sessions.issue(
      accepted ? { user, req, tenantId: accepted.tenantId } : { user, req, tenantSlug },
    );

    await this.db.platform.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date(), lastLoginIp: req.ip ?? null, failedLoginAttempts: 0 },
    });
    await this.audit.record({
      tenantId: session.activeTenant.tenantId,
      actorUserId: user.id,
      actorEmail: user.email,
      action: 'LOGIN',
      resourceType: 'User',
      resourceId: user.id,
      resourceLabel: user.email,
      ip: req.ip,
      userAgent: req.headers['user-agent']?.slice(0, 500),
      traceId: traceIdOf(req),
    });

    return { response: session, refreshToken };
  }

  /* ======================================================================== */
  /*  Recuperación de contraseña                                               */
  /* ======================================================================== */

  /** Misma respuesta exista o no la cuenta. */
  async forgotPassword(email: string, req: Request): Promise<void> {
    await this.assertEmailRateLimit(email);
    const user = await this.db.platform.user.findUnique({ where: { email } });
    if (!user || user.deletedAt || user.status === 'DISABLED') return;

    const token = await this.tokens.create(
      user.id,
      'PASSWORD_RESET',
      AUTH_TIMINGS.passwordResetMinutes * 60_000,
    );
    await this.mail.send(
      user.email,
      passwordResetEmail({
        name: user.name,
        url: this.mail.webUrl('/restablecer', { token }),
        minutes: AUTH_TIMINGS.passwordResetMinutes,
      }),
      { category: 'auth', traceId: traceIdOf(req) },
    );
  }

  async resetPassword(token: string, password: string, req: Request): Promise<void> {
    const userId = await this.tokens.consume(token, 'PASSWORD_RESET');
    if (!userId) throw invalidLink();

    const current = await this.db.platform.user.findUnique({ where: { id: userId } });
    if (!current || current.deletedAt) throw invalidLink();

    const user = await this.db.platform.user.update({
      where: { id: userId },
      data: {
        passwordHash: await hashPassword(password),
        failedLoginAttempts: 0,
        // Quien recibió el correo demostró controlar el buzón: vale como
        // verificación si todavía no la tenía. Pero una cuenta DESACTIVADA por
        // un administrador sigue desactivada: cambiar la contraseña no la abre.
        ...(current.status === 'PENDING_VERIFICATION'
          ? { status: 'ACTIVE' as const, emailVerifiedAt: new Date() }
          : {}),
      },
    });

    // Si alguien tenía la contraseña anterior, pierde todas las sesiones.
    await this.sessions.revokeAllForUser(user.id, 'password_change');

    await this.mail.send(
      user.email,
      passwordChangedEmail({ name: user.name, resetUrl: this.mail.webUrl('/recuperar') }),
      { category: 'auth', traceId: traceIdOf(req) },
    );

    const tenants = (await this.sessions.usableMemberships(user.id)).map((m) => m.tenantId);
    await this.audit.recordForTenants(tenants, {
      actorUserId: user.id,
      actorEmail: user.email,
      action: 'PASSWORD_CHANGE',
      resourceType: 'User',
      resourceId: user.id,
      resourceLabel: user.email,
      ip: req.ip,
      userAgent: req.headers['user-agent']?.slice(0, 500),
      traceId: traceIdOf(req),
    });
  }

  /* ======================================================================== */

  /**
   * Límite de correos por dirección: registro, reenvío y recuperación.
   *
   * Sin él, estos formularios servirían para inundar el buzón de cualquiera.
   * Superarlo no da error visible —delataría que el correo existe—: se
   * responde igual, pero no se envía nada.
   */
  private async assertEmailRateLimit(email: string): Promise<void> {
    const result = await this.limiter.consume(
      'email-send',
      email,
      LIMITS.emailsPerAddress.max,
      LIMITS.emailsPerAddress.windowSeconds,
    );
    if (!result.allowed) throw new SilentlyIgnored();
  }
}

/** Petición que se responde con éxito sin hacer nada (límite de correos). */
export class SilentlyIgnored extends Error {}

function invalidLink(): ProblemException {
  return new ProblemException({
    type: AUTH_PROBLEMS.TOKEN_INVALID,
    title: 'Enlace no válido',
    status: HttpStatus.BAD_REQUEST,
    detail: 'El enlace caducó o ya se usó. Pide uno nuevo.',
  });
}

function invalidTwoFactor(): ProblemException {
  return new ProblemException({
    type: AUTH_PROBLEMS.TWO_FACTOR_INVALID,
    title: 'Código incorrecto',
    status: HttpStatus.UNAUTHORIZED,
    detail: 'El código no es válido o ya se usó. Espera al siguiente código del autenticador.',
  });
}

function tooManyAttempts(retryAfter: number): ProblemException {
  const minutes = Math.ceil(retryAfter / 60);
  return new ProblemException(
    {
      type: PROBLEM_TYPES.RATE_LIMITED,
      title: 'Demasiados intentos',
      status: HttpStatus.TOO_MANY_REQUESTS,
      detail: `Por seguridad, espera ${minutes} ${minutes === 1 ? 'minuto' : 'minutos'} antes de volver a intentarlo.`,
    },
    { 'Retry-After': String(retryAfter) },
  );
}

/** Slug de la empresa: el de `toSlug`, con sufijo si es muy corto o una ruta reservada. */
export function slugify(value: string): string {
  const slug = toSlug(value);
  // Demasiado corto, o una ruta del producto (`admin`, `api`, `login`…): una
  // empresa llamada "Admin" no puede quedarse con /admin.
  if (slug.length < 3 || RESERVED_SLUGS.has(slug))
    return `${slug || 'empresa'}-${randomUUID().slice(0, 6)}`;
  return slug;
}
