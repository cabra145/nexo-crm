import { randomUUID } from 'node:crypto';
import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import {
  AUTH_PROBLEMS,
  AUTH_TIMINGS,
  REFRESH_COOKIE,
  type ApiEnv,
  type SessionMembership,
  type SessionResponse,
  type TwoFactorRequirement,
} from '@nexo/contracts';
import { runAsAuthenticatedUser, type User } from '@nexo/database';
import type { CookieOptions, Request, Response } from 'express';
import { generateToken, sha256 } from '../common/crypto/tokens';
import { ProblemException } from '../common/problem.exception';
import { API_ENV } from '../config/config.module';
import { DatabaseService } from '../database/database.service';

/** Contenido del token de acceso. Nombres cortos: viaja en cada petición. */
export interface AccessTokenClaims {
  typ: 'access';
  /** Usuario */
  sub: string;
  /** Empresa activa */
  tid: string;
  /** Membresía en esa empresa */
  mid: string;
  /** Rol del sistema en esa empresa */
  role: SessionMembership['role'];
  /** Familia de la sesión: permite cerrar exactamente esta sesión */
  fam: string;
  /** Estado del 2FA obligatorio: `blocked` sólo deja configurar el 2FA */
  tfa: 'ok' | 'pending' | 'blocked';
}

interface MembershipRow {
  id: string;
  tenantId: string;
  acceptedAt: Date | null;
  createdAt: Date;
  tenant: { id: string; slug: string; name: string; status: string; deletedAt: Date | null };
  role: { key: SessionMembership['role']; name: string };
}

/** Estados en los que una empresa admite iniciar sesión. */
const USABLE_TENANT_STATUSES = new Set(['TRIAL', 'ACTIVE', 'PAST_DUE']);

@Injectable()
export class SessionService {
  private readonly logger = new Logger('Sesiones');

  constructor(
    private readonly db: DatabaseService,
    private readonly jwt: JwtService,
    @Inject(API_ENV) private readonly env: ApiEnv,
  ) {}

  /* ======================================================================== */
  /*  Membresías                                                               */
  /* ======================================================================== */

  /**
   * Empresas en las que el usuario puede entrar.
   *
   * Se leen con la identidad del usuario (`app.user_id`), sin empresa activa:
   * las políticas RLS de lectura propia sólo le dejan ver SUS membresías.
   */
  async usableMemberships(userId: string): Promise<MembershipRow[]> {
    const rows = await runAsAuthenticatedUser(userId, (tx) =>
      tx.membership.findMany({
        where: { userId, status: 'ACTIVE' },
        select: {
          id: true,
          tenantId: true,
          acceptedAt: true,
          createdAt: true,
          tenant: { select: { id: true, slug: true, name: true, status: true, deletedAt: true } },
          role: { select: { key: true, name: true } },
        },
        orderBy: { createdAt: 'asc' },
      }),
    );
    return rows.filter((m) => !m.tenant.deletedAt && USABLE_TENANT_STATUSES.has(m.tenant.status));
  }

  toSessionMembership(m: MembershipRow): SessionMembership {
    return {
      membershipId: m.id,
      tenantId: m.tenantId,
      tenantSlug: m.tenant.slug,
      tenantName: m.tenant.name,
      role: m.role.key,
      roleName: m.role.name,
    };
  }

  /**
   * Plazo del 2FA. Sólo el rol Propietario lo exige, con 7 días de gracia
   * desde que entró en la empresa: tiempo real para configurarlo sin fricción
   * en el primer uso, y bloqueo de verdad si no lo hace.
   */
  twoFactorRequirement(
    membership: MembershipRow,
    user: Pick<User, 'totpEnabled'>,
    now = Date.now(),
  ): TwoFactorRequirement {
    const required = membership.role.key === 'OWNER';
    if (!required || user.totpEnabled) {
      return { required, enabled: user.totpEnabled, deadline: null, blocked: false };
    }
    const since = (membership.acceptedAt ?? membership.createdAt).getTime();
    const deadline = new Date(since + AUTH_TIMINGS.ownerTwoFactorGraceDays * 86_400_000);
    return {
      required,
      enabled: false,
      deadline: deadline.toISOString(),
      blocked: now > deadline.getTime(),
    };
  }

  /* ======================================================================== */
  /*  Emisión                                                                  */
  /* ======================================================================== */

  /**
   * Crea una sesión: token de acceso + token de refresco en una familia.
   *
   * @param tenantId   empresa concreta (cambio de empresa, refresco)
   * @param tenantSlug empresa pedida al iniciar sesión
   * @param familyId   familia existente (refresco) o nueva (inicio de sesión)
   */
  async issue(params: {
    user: User;
    req: Request;
    tenantId?: string;
    tenantSlug?: string;
    familyId?: string;
  }): Promise<{ session: SessionResponse; refreshToken: string }> {
    const { user } = params;
    const memberships = await this.usableMemberships(user.id);

    if (memberships.length === 0) {
      throw new ProblemException({
        type: AUTH_PROBLEMS.TENANT_UNAVAILABLE,
        title: 'Sin empresas disponibles',
        status: HttpStatus.FORBIDDEN,
        detail:
          'Tu cuenta no pertenece a ninguna empresa activa. Pide una invitación al administrador.',
      });
    }

    const lastTenantId = (user.preferences as { lastTenantId?: string } | null)?.lastTenantId;
    let active: MembershipRow | undefined;

    if (params.tenantId || params.tenantSlug) {
      active = memberships.find(
        (m) => m.tenantId === params.tenantId || m.tenant.slug === params.tenantSlug,
      );
      if (!active) {
        throw new ProblemException({
          type: AUTH_PROBLEMS.TENANT_UNAVAILABLE,
          title: 'Empresa no disponible',
          status: HttpStatus.FORBIDDEN,
          detail: 'No perteneces a esa empresa, o está suspendida.',
        });
      }
    } else {
      active = memberships.find((m) => m.tenantId === lastTenantId) ?? memberships[0]!;
    }

    const familyId = params.familyId ?? randomUUID();
    const refreshToken = generateToken();

    await this.db.platform.refreshToken.create({
      data: {
        userId: user.id,
        familyId,
        tenantId: active.tenantId,
        tokenHash: sha256(refreshToken),
        userAgent: params.req.headers['user-agent']?.slice(0, 500) ?? null,
        ip: params.req.ip ?? null,
        expiresAt: new Date(Date.now() + AUTH_TIMINGS.refreshTokenDays * 86_400_000),
      },
    });

    if (lastTenantId !== active.tenantId) {
      await this.db.platform.user.update({
        where: { id: user.id },
        data: {
          preferences: {
            ...((user.preferences as object | null) ?? {}),
            lastTenantId: active.tenantId,
          },
        },
      });
    }

    const twoFactor = this.twoFactorRequirement(active, user);
    const claims: AccessTokenClaims = {
      typ: 'access',
      sub: user.id,
      tid: active.tenantId,
      mid: active.id,
      role: active.role.key,
      fam: familyId,
      tfa: twoFactor.blocked
        ? 'blocked'
        : twoFactor.required && !twoFactor.enabled
          ? 'pending'
          : 'ok',
    };

    const accessToken = await this.jwt.signAsync(claims, {
      secret: this.env.JWT_ACCESS_SECRET,
      expiresIn: AUTH_TIMINGS.accessTokenSeconds,
      algorithm: 'HS256',
    });

    return {
      refreshToken,
      session: {
        accessToken,
        expiresIn: AUTH_TIMINGS.accessTokenSeconds,
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          avatarUrl: user.avatarUrl,
          twoFactorEnabled: user.totpEnabled,
        },
        activeTenant: this.toSessionMembership(active),
        memberships: memberships.map((m) => this.toSessionMembership(m)),
        twoFactor,
      },
    };
  }

  async verifyAccessToken(token: string): Promise<AccessTokenClaims> {
    const claims = await this.jwt.verifyAsync<AccessTokenClaims>(token, {
      secret: this.env.JWT_ACCESS_SECRET,
      algorithms: ['HS256'],
    });
    if (claims.typ !== 'access') throw new Error('No es un token de acceso');
    return claims;
  }

  /* ======================================================================== */
  /*  Rotación del token de refresco                                          */
  /* ======================================================================== */

  /**
   * Cambia un token de refresco por una sesión nueva.
   *
   * Cada token sirve UNA vez. Si llega uno que ya se usó, alguien tiene una
   * copia —la cookie fue robada, o se filtró de otra forma—: no se puede saber
   * quién es el legítimo, así que se revoca la familia entera y los dos tienen
   * que volver a iniciar sesión. El legítimo pierde una sesión; el atacante
   * pierde el acceso.
   */
  async rotate(
    refreshToken: string,
    req: Request,
    options: { tenantId?: string; expectedUserId?: string } = {},
  ): Promise<{ session: SessionResponse; refreshToken: string }> {
    const { tenantId } = options;
    const tokenHash = sha256(refreshToken);
    const existing = await this.db.platform.refreshToken.findUnique({
      where: { tokenHash },
      include: { user: true },
    });

    const expired = () =>
      new ProblemException({
        type: AUTH_PROBLEMS.SESSION_EXPIRED,
        title: 'Sesión caducada',
        status: HttpStatus.UNAUTHORIZED,
        detail: 'Tu sesión ha terminado. Vuelve a iniciar sesión.',
      });

    if (!existing) throw expired();

    if (existing.usedAt || existing.revokedAt) {
      if (existing.usedAt && !existing.revokedAt) {
        await this.revokeFamily(existing.familyId, 'reuse_detected');
        this.logger.warn(
          `Reuso de token de refresco detectado (usuario ${existing.userId}, familia ${existing.familyId}): familia revocada`,
        );
      }
      throw expired();
    }

    if (
      existing.expiresAt.getTime() <= Date.now() ||
      existing.user.status !== 'ACTIVE' ||
      existing.user.deletedAt
    ) {
      await this.revokeFamily(existing.familyId, 'expired_or_disabled');
      throw expired();
    }

    // La cookie tiene que ser del mismo usuario que el token de acceso con el
    // que se pide el cambio de empresa.
    if (options.expectedUserId && options.expectedUserId !== existing.userId) {
      throw expired();
    }

    // Se comprueba ANTES de canjear el token. Si se canjeara primero y la
    // empresa no fuera válida, el usuario perdería su sesión por pedir una
    // empresa equivocada.
    if (
      tenantId &&
      !(await this.usableMemberships(existing.userId)).some((m) => m.tenantId === tenantId)
    ) {
      throw new ProblemException({
        type: AUTH_PROBLEMS.TENANT_UNAVAILABLE,
        title: 'Empresa no disponible',
        status: HttpStatus.FORBIDDEN,
        detail: 'No perteneces a esa empresa, o está suspendida.',
      });
    }

    // Canje atómico: si dos peticiones llegan a la vez con el mismo token, sólo
    // una lo marca como usado. La otra se trata como reuso.
    const claimed = await this.db.platform.refreshToken.updateMany({
      where: { id: existing.id, usedAt: null, revokedAt: null },
      data: { usedAt: new Date() },
    });
    if (claimed.count === 0) {
      await this.revokeFamily(existing.familyId, 'reuse_detected');
      throw expired();
    }

    return this.issue({
      user: existing.user,
      req,
      tenantId: tenantId ?? existing.tenantId ?? undefined,
      familyId: existing.familyId,
    });
  }

  async revokeFamily(familyId: string, reason: string): Promise<void> {
    await this.db.platform.refreshToken.updateMany({
      where: { familyId, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: reason },
    });
  }

  /** Cierra todas las sesiones de un usuario, opcionalmente salvo una familia. */
  async revokeAllForUser(userId: string, reason: string, exceptFamilyId?: string): Promise<void> {
    await this.db.platform.refreshToken.updateMany({
      where: {
        userId,
        revokedAt: null,
        ...(exceptFamilyId ? { NOT: { familyId: exceptFamilyId } } : {}),
      },
      data: { revokedAt: new Date(), revokedReason: reason },
    });
  }

  async familyOf(refreshToken: string): Promise<string | null> {
    const row = await this.db.platform.refreshToken.findUnique({
      where: { tokenHash: sha256(refreshToken) },
      select: { familyId: true },
    });
    return row?.familyId ?? null;
  }

  /* ======================================================================== */
  /*  Cookie                                                                   */
  /* ======================================================================== */

  private cookieOptions(): CookieOptions {
    return {
      httpOnly: true,
      // En desarrollo la web y la API van por http://localhost; en producción,
      // la cookie sólo viaja por HTTPS.
      secure: this.env.NODE_ENV === 'production',
      // Lax: se envía en navegación normal desde nuestro dominio, no en
      // peticiones POST iniciadas desde otros sitios.
      sameSite: 'lax',
      // Sólo viaja a las rutas de autenticación, no en cada petición a la API.
      path: '/api/v1/auth',
      domain: this.env.COOKIE_DOMAIN || undefined,
    };
  }

  setRefreshCookie(res: Response, token: string): void {
    res.cookie(REFRESH_COOKIE, token, {
      ...this.cookieOptions(),
      maxAge: AUTH_TIMINGS.refreshTokenDays * 86_400_000,
    });
  }

  clearRefreshCookie(res: Response): void {
    res.clearCookie(REFRESH_COOKIE, this.cookieOptions());
  }

  readRefreshCookie(req: Request): string | null {
    const cookies = req.cookies as Record<string, unknown> | undefined;
    const value = cookies?.[REFRESH_COOKIE];
    return typeof value === 'string' && value.length > 0 ? value : null;
  }
}
