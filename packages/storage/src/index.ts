/**
 * @nexo/storage — almacenamiento de objetos sin depender del proveedor.
 *
 * La lógica de negocio usa `ObjectStorage`; la configuración decide si detrás
 * está Cloudflare R2, Amazon S3 o MinIO.
 */
export * from './object-storage';
export * from './config';
export * from './keys';
export * from './sniff';
export { S3ObjectStorage, contentDisposition } from './s3-storage';

import { type StorageEnv, resolveStorageConfig } from './config';
import type { ObjectStorage } from './object-storage';
import { S3ObjectStorage } from './s3-storage';

/** El almacenamiento configurado, o null si está desactivado (sólo fuera de producción). */
export function createObjectStorage(env: StorageEnv): ObjectStorage | null {
  const config = resolveStorageConfig(env);
  return config ? new S3ObjectStorage(config) : null;
}
