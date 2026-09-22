import {
  Global,
  Inject,
  Injectable,
  Logger,
  Module,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import type { ApiEnv } from '@nexo/contracts';
import { createObjectStorage, type ObjectStorage } from '@nexo/storage';
import { API_ENV } from '../config/config.module';

/**
 * Almacenamiento de objetos de la API. `null` = desactivado (sólo fuera de
 * producción, sin credenciales): lo que lo necesite responde que no está
 * disponible, en vez de fallar a mitad.
 *
 * La lógica de negocio inyecta `OBJECT_STORAGE` y usa la interfaz
 * `ObjectStorage`: no sabe si detrás hay R2, S3 o MinIO.
 */
export const OBJECT_STORAGE = Symbol('OBJECT_STORAGE');

@Injectable()
class StorageCheck implements OnApplicationBootstrap {
  private readonly logger = new Logger('Almacenamiento');

  constructor(
    @Inject(API_ENV) private readonly env: ApiEnv,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage | null,
  ) {}

  /**
   * Comprueba el acceso al arrancar. En producción, unas credenciales o un
   * bucket equivocados paran el despliegue aquí, no con el primer adjunto de
   * un cliente horas después.
   */
  async onApplicationBootstrap(): Promise<void> {
    if (!this.storage) {
      this.logger.warn(
        'Desactivado: faltan S3_ACCESS_KEY y S3_SECRET_KEY. Los archivos no estarán disponibles.',
      );
      return;
    }
    try {
      await this.storage.checkAccess();
      this.logger.log(`${this.storage.provider} · bucket «${this.storage.bucket}»`);
    } catch (error) {
      if (this.env.NODE_ENV === 'production') throw error;
      this.logger.warn(
        `${(error as Error).message}. ¿Está levantado MinIO? → docker compose --env-file .env -f infra/compose.yml up -d`,
      );
    }
  }
}

@Global()
@Module({
  providers: [
    // Una configuración incoherente lanza aquí, al crear el módulo: la API no
    // arranca y el mensaje dice qué variable corregir.
    {
      provide: OBJECT_STORAGE,
      inject: [API_ENV],
      useFactory: (env: ApiEnv) => createObjectStorage(env),
    },
    StorageCheck,
  ],
  exports: [OBJECT_STORAGE],
})
export class StorageModule {}
