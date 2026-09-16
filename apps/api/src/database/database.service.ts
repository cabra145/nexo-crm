import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';
import type { ApiEnv } from '@nexo/contracts';
import {
  disconnectDatabase,
  platformPrisma,
  prisma,
  verifyTenantIsolation,
} from '@nexo/database';
import { API_ENV } from '../config/config.module';

/**
 * Punto de acceso a la base de datos para toda la API.
 *
 * Expone los dos clientes con nombres que dicen para qué sirve cada uno:
 *
 *   `db.tenant`    → datos de negocio. Exige contexto de empresa y aplica el
 *                    aislamiento automáticamente. Es el que se usa el 99 % de
 *                    las veces.
 *   `db.platform`  → sin ámbito de empresa. Sólo autenticación, panel de
 *                    plataforma y mantenimiento.
 *
 * Además, al arrancar comprueba contra Postgres que el aislamiento entre
 * empresas esté completo.
 */
@Injectable()
export class DatabaseService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger('Base de datos');

  readonly tenant = prisma;
  readonly platform = platformPrisma;

  constructor(@Inject(API_ENV) private readonly env: ApiEnv) {}

  async onModuleInit(): Promise<void> {
    try {
      await platformPrisma.$connect();
      this.logger.log('Conectado a PostgreSQL');
    } catch (error) {
      const message = error instanceof Error ? error.message.split('\n')[0] : String(error);

      // En producción, arrancar sin base de datos sólo produce errores 500 en
      // cada petición. Mejor fallar y que el orquestador lo reintente.
      if (this.env.NODE_ENV === 'production') {
        throw new Error(`No se pudo conectar a PostgreSQL: ${message}`);
      }

      // En desarrollo se arranca igualmente: así se puede trabajar en rutas que
      // no tocan la base mientras Docker levanta. /health/ready lo refleja.
      this.logger.warn(
        `No se pudo conectar a PostgreSQL (${message}). La API arranca igualmente; ` +
          '¿está levantado Docker? → docker compose --env-file .env -f infra/compose.yml up -d',
      );
      return;
    }

    await this.checkTenantIsolation();
  }

  /**
   * Comprueba que toda tabla con `tenant_id` tenga su política RLS activa y
   * forzada, y que el rol de la aplicación no tenga BYPASSRLS.
   *
   * En producción, un agujero de aislamiento ABORTA el arranque. Es preferible
   * una API caída a una API que sirve datos de una empresa a otra.
   */
  private async checkTenantIsolation(): Promise<void> {
    const isProduction = this.env.NODE_ENV === 'production';

    let problems: Array<{ table_name: string; problem: string }>;
    try {
      problems = await verifyTenantIsolation();
    } catch {
      const hint =
        'No se pudo verificar el aislamiento entre empresas: la función ' +
        'verify_tenant_isolation() no existe. ¿Aplicaste las migraciones? → pnpm db:migrate';

      if (isProduction) throw new Error(hint);
      this.logger.warn(hint);
      return;
    }

    if (problems.length === 0) {
      this.logger.log('Aislamiento entre empresas verificado');
      return;
    }

    const detail = problems.map((p) => `  · ${p.table_name} → ${p.problem}`).join('\n');
    const message = `AISLAMIENTO INCOMPLETO — ${problems.length} problema(s):\n${detail}\n→ pnpm --filter @nexo/database rls`;

    if (isProduction) throw new Error(message);
    this.logger.error(message);
  }

  async onApplicationShutdown(): Promise<void> {
    await disconnectDatabase();
  }
}
