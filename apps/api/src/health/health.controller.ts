import { Controller, Get, Inject, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import type { Response } from 'express';
import type Redis from 'ioredis';
import { Public } from '../auth/decorators';
import { DatabaseService } from '../database/database.service';
import { type ObjectStorage, StorageAccessError } from '@nexo/storage';
import { REDIS } from '../redis/redis.module';
import { OBJECT_STORAGE } from '../storage/storage.module';

interface Check {
  status: 'up' | 'down' | 'disabled';
  latencyMs?: number;
  detail?: string;
}

/** Tiempo máximo por comprobación. Una sonda de salud que se cuelga es peor que una que falla. */
const CHECK_TIMEOUT_MS = 2_000;

async function timed(run: () => Promise<string | void>): Promise<Check> {
  const started = performance.now();
  try {
    const detail = await Promise.race([
      run(),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`sin respuesta en ${CHECK_TIMEOUT_MS} ms`)),
          CHECK_TIMEOUT_MS,
        ),
      ),
    ]);
    return {
      status: 'up',
      latencyMs: Math.round(performance.now() - started),
      ...(detail ? { detail } : {}),
    };
  } catch (error) {
    return {
      status: 'down',
      latencyMs: Math.round(performance.now() - started),
      detail: error instanceof Error ? error.message.split('\n')[0] : String(error),
    };
  }
}

/**
 * Dos sondas distintas, con propósitos distintos:
 *
 *   GET /health        → ¿está vivo el proceso? No toca dependencias. Si esto
 *                        falla, hay que reiniciar el contenedor.
 *   GET /health/ready  → ¿puede atender tráfico? Comprueba Postgres, Redis y
 *                        el aislamiento entre empresas (e informa del
 *                        almacenamiento, sin que decida). Si esto falla, hay que
 *                        dejar de enviarle tráfico, NO reiniciarlo.
 *
 * Mezclarlas en una sola es un error clásico: una caída breve de Redis
 * provocaría reinicios en cascada de todas las instancias de la API.
 */
@ApiTags('Salud')
@Public()
@SkipThrottle()
@Controller('health')
export class HealthController {
  constructor(
    private readonly db: DatabaseService,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage | null,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Sonda de vida: el proceso responde' })
  liveness() {
    return {
      status: 'ok',
      service: 'nexo-api',
      version: process.env.npm_package_version ?? '0.1.0',
      uptimeSeconds: Math.round(process.uptime()),
      timestamp: new Date().toISOString(),
    };
  }

  @Get('ready')
  @ApiOperation({ summary: 'Sonda de disponibilidad: dependencias y aislamiento' })
  async readiness(@Res({ passthrough: true }) res: Response) {
    const [database, redis, tenantIsolation, storage] = await Promise.all([
      timed(async () => {
        await this.db.platform.$queryRaw`SELECT 1`;
      }),
      timed(async () => {
        // Los tipos de ioredis dicen que ping() sólo puede devolver 'PONG'; la
        // comprobación existe precisamente para cuando la realidad no coincida.
        const pong: string = await this.redis.ping();
        if (pong !== 'PONG') throw new Error(`respuesta inesperada: ${pong}`);
      }),
      timed(async () => {
        const problems = await this.db.platform.$queryRaw<Array<{ table_name: string }>>`
          SELECT table_name FROM verify_tenant_isolation()
        `;
        if (problems.length > 0) {
          throw new Error(
            `${problems.length} tabla(s) sin aislamiento: ${problems.map((p) => p.table_name).join(', ')}`,
          );
        }
        return 'todas las tablas con tenant_id tienen RLS forzada';
      }),
      this.storage
        ? timed(async () => {
            // Esta sonda es pública: el motivo sí, el nombre del bucket no.
            await this.storage!.checkAccess().catch((error: unknown) => {
              throw error instanceof StorageAccessError ? new Error(error.reason) : error;
            });
          })
        : Promise.resolve<Check>({ status: 'disabled', detail: 'sin credenciales' }),
    ]);

    // El almacenamiento se informa pero NO decide la disponibilidad: si R2 cae,
    // sólo fallan los archivos, y sacar la API del balanceador cortaría también
    // el chat, el CRM y el inicio de sesión. Al ARRANCAR sí es obligatorio
    // (StorageModule).
    const ready = [database, redis, tenantIsolation].every((c) => c.status === 'up');
    res.status(ready ? 200 : 503);

    return {
      status: ready ? 'ready' : 'degraded',
      checks: { database, redis, tenantIsolation, storage },
      timestamp: new Date().toISOString(),
    };
  }
}
