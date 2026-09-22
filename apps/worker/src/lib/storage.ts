import { createObjectStorage, type ObjectStorage } from '@nexo/storage';
import { env } from '../bootstrap/env';
import { logger } from './logger';

/**
 * Almacenamiento del worker (archivos de WhatsApp). Se crea UNA vez al
 * importar: una configuración incoherente lanza aquí y el worker no arranca.
 * `null` = desactivado (sólo fuera de producción, sin credenciales).
 */
export const storage: ObjectStorage | null = createObjectStorage(env);

/**
 * Comprueba el acceso al arrancar. En producción, sin acceso no se arranca:
 * mejor un despliegue fallido que archivos de clientes que no se guardan.
 */
export async function checkStorage(): Promise<void> {
  const log = logger.child({ component: 'almacenamiento' });
  if (!storage) {
    log.warn('Desactivado: faltan S3_ACCESS_KEY y S3_SECRET_KEY. Los archivos no se guardarán.');
    return;
  }
  try {
    await storage.checkAccess();
    log.info({ provider: storage.provider, bucket: storage.bucket }, 'Almacenamiento disponible');
  } catch (error) {
    if (env.NODE_ENV === 'production') throw error;
    log.warn(
      { err: (error as Error).message },
      'Almacenamiento no disponible; ¿está levantado MinIO? → docker compose --env-file .env -f infra/compose.yml up -d',
    );
  }
}
