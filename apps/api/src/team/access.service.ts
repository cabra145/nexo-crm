import { Inject, Injectable, Logger } from '@nestjs/common';
import type { AccessView } from '@nexo/contracts';
import { prisma, runWithTenantContext } from '@nexo/database';
import type Redis from 'ioredis';
import { REDIS } from '../redis/redis.module';

/** Acceso resuelto de una membresía: lo que el guard necesita en cada petición. */
export interface ResolvedAccess extends AccessView {
  tenantId: string;
  status: 'INVITED' | 'ACTIVE' | 'DISABLED';
}

/** Vida de la entrada en caché. La invalidación es explícita; esto es la red. */
const CACHE_SECONDS = 300;

/**
 * Permisos EN VIVO de una membresía.
 *
 * El token de acceso lleva el rol, pero dura 15 minutos: si en ese tiempo a
 * alguien le quitan un permiso, lo desactivan o lo sacan de la empresa, el
 * token todavía lo diría. Por eso los permisos no se leen del token: se leen
 * de aquí en cada petición.
 *
 * Caché en Redis por empresa y generación. Cualquier cambio de miembros o de
 * roles de una empresa incrementa su generación (`invalidateTenant`), y todas
 * sus entradas anteriores dejan de usarse a la vez: no hay que saber qué
 * membresías afecta un cambio de rol. Si Redis no responde, se lee de la base.
 */
@Injectable()
export class AccessService {
  private readonly logger = new Logger('Permisos');

  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  private generationKey(tenantId: string): string {
    return `nexo:access:gen:${tenantId}`;
  }

  async resolve(tenantId: string, membershipId: string): Promise<ResolvedAccess | null> {
    let cacheKey: string | null = null;
    try {
      const generation = (await this.redis.get(this.generationKey(tenantId))) ?? '0';
      cacheKey = `nexo:access:${tenantId}:${generation}:${membershipId}`;
      const cached = await this.redis.get(cacheKey);
      if (cached) return JSON.parse(cached) as ResolvedAccess | null;
    } catch (error) {
      this.logger.warn(`Caché de permisos no disponible: ${(error as Error).message}`);
      cacheKey = null;
    }

    const access = await this.load(tenantId, membershipId);

    if (cacheKey) {
      await this.redis
        .set(cacheKey, JSON.stringify(access), 'EX', CACHE_SECONDS)
        .catch(() => undefined);
    }
    return access;
  }

  /**
   * Invalida los permisos cacheados de TODA la empresa. Se llama después de
   * confirmar cualquier cambio de miembros o roles.
   *
   * Si Redis no responde, el cambio se aplica igualmente al caducar la caché
   * (5 min). Se deja constancia en el log porque es una ventana de permisos
   * obsoletos.
   */
  async invalidateTenant(tenantId: string): Promise<void> {
    try {
      await this.redis.incr(this.generationKey(tenantId));
    } catch (error) {
      this.logger.error(
        `No se pudo invalidar la caché de permisos de la empresa ${tenantId}: ${(error as Error).message}`,
      );
    }
  }

  private load(tenantId: string, membershipId: string): Promise<ResolvedAccess | null> {
    return runWithTenantContext({ tenantId, membershipId, actorType: 'SYSTEM' }, async () => {
      const membership = await prisma.membership.findUnique({
        where: { id: membershipId },
        select: {
          id: true,
          userId: true,
          status: true,
          teamName: true,
          role: {
            select: {
              id: true,
              key: true,
              name: true,
              permissions: { select: { permission: true, scope: true } },
            },
          },
        },
      });
      if (!membership) return null;

      return {
        tenantId,
        membershipId: membership.id,
        userId: membership.userId,
        status: membership.status,
        teamName: membership.teamName,
        role: {
          id: membership.role.id,
          key: membership.role.key,
          name: membership.role.name,
        },
        permissions: Object.fromEntries(
          membership.role.permissions.map((p) => [p.permission, p.scope]),
        ),
      };
    });
  }
}
