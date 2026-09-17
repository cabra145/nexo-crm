import { Inject, Injectable } from '@nestjs/common';
import type Redis from 'ioredis';
import { sha256 } from '../common/crypto/tokens';
import { REDIS } from '../redis/redis.module';

export interface LimitResult {
  allowed: boolean;
  /** Segundos hasta que se libera, si no está permitido. */
  retryAfter: number;
}

/**
 * Límites de intentos de la autenticación, en Redis.
 *
 * Complementan el límite global de la API (por IP y minuto): aquí se cuentan
 * los intentos FALLIDOS por cuenta, que es lo que detiene la fuerza bruta
 * contra una contraseña concreta aunque venga repartida desde muchas IPs.
 *
 * Los correos nunca se guardan en claro en Redis: la clave usa su SHA-256.
 */
@Injectable()
export class RateLimiterService {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  private key(scope: string, subject: string): string {
    return `nexo:auth:${scope}:${sha256(subject.toLowerCase())}`;
  }

  /** ¿Se ha superado el máximo? No cuenta un intento nuevo. */
  async isBlocked(scope: string, subject: string, max: number): Promise<LimitResult> {
    const key = this.key(scope, subject);
    const [count, ttl] = await Promise.all([this.redis.get(key), this.redis.ttl(key)]);
    const blocked = Number(count ?? 0) >= max;
    return { allowed: !blocked, retryAfter: blocked ? Math.max(ttl, 1) : 0 };
  }

  /** Suma un intento; la ventana empieza con el primero. */
  async hit(scope: string, subject: string, windowSeconds: number): Promise<number> {
    const key = this.key(scope, subject);
    const count = await this.redis.incr(key);
    if (count === 1) await this.redis.expire(key, windowSeconds);
    return count;
  }

  /** Cuenta y comprueba en una sola llamada (para acciones que siempre cuentan). */
  async consume(
    scope: string,
    subject: string,
    max: number,
    windowSeconds: number,
  ): Promise<LimitResult> {
    const count = await this.hit(scope, subject, windowSeconds);
    if (count <= max) return { allowed: true, retryAfter: 0 };
    const ttl = await this.redis.ttl(this.key(scope, subject));
    return { allowed: false, retryAfter: Math.max(ttl, 1) };
  }

  async reset(scope: string, subject: string): Promise<void> {
    await this.redis.del(this.key(scope, subject));
  }

  /**
   * Marca un valor como usado una sola vez durante `ttlSeconds`.
   * Devuelve false si ya estaba usado. Evita reutilizar un código TOTP o un
   * token de desafío 2FA dentro de su periodo de validez.
   */
  async claimOnce(scope: string, value: string, ttlSeconds: number): Promise<boolean> {
    const result = await this.redis.set(this.key(scope, value), '1', 'EX', ttlSeconds, 'NX');
    return result === 'OK';
  }
}
