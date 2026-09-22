/**
 * Configuración del almacenamiento a partir del entorno.
 *
 * El proveedor sólo cambia los valores POR DEFECTO; todo se puede fijar a
 * mano. Así el código no tiene ramas por proveedor y uno nuevo compatible con
 * S3 (Backblaze B2, Wasabi…) se añade sin tocar nada más.
 *
 *              endpoint                                    región     rutas
 *   r2         https://<R2_ACCOUNT_ID>.r2.cloudflarestorage.com  auto   virtual
 *   s3         el de AWS según la región                   us-east-1  virtual
 *   minio      S3_ENDPOINT (obligatorio)                   us-east-1  path
 */

export const STORAGE_PROVIDERS = ['r2', 's3', 'minio'] as const;
export type StorageProvider = (typeof STORAGE_PROVIDERS)[number];

export interface StorageEnv {
  NODE_ENV?: string;
  STORAGE_PROVIDER?: StorageProvider;
  R2_ACCOUNT_ID?: string;
  S3_ENDPOINT?: string;
  S3_PUBLIC_ENDPOINT?: string;
  S3_REGION?: string;
  S3_BUCKET?: string;
  S3_ACCESS_KEY?: string;
  S3_SECRET_KEY?: string;
  S3_FORCE_PATH_STYLE?: boolean;
}

export interface StorageConfig {
  provider: StorageProvider;
  /** Donde habla el servidor. Sin él, el del proveedor (AWS). */
  endpoint: string | undefined;
  /**
   * Donde habla el NAVEGADOR con las URL firmadas. Distinto sólo si el
   * servidor llega al almacenamiento por una red interna (Docker).
   */
  publicEndpoint: string | undefined;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
}

export class StorageConfigError extends Error {
  constructor(message: string) {
    super(`Almacenamiento mal configurado: ${message}`);
    this.name = 'StorageConfigError';
  }
}

/**
 * Resuelve la configuración. Devuelve null si no hay credenciales FUERA de
 * producción (el almacenamiento queda desactivado y lo que lo necesite lo
 * dice); en producción, la falta de cualquier dato impide arrancar.
 */
export function resolveStorageConfig(env: StorageEnv): StorageConfig | null {
  const provider = env.STORAGE_PROVIDER ?? 'r2';
  const production = env.NODE_ENV === 'production';

  if (!env.S3_ACCESS_KEY || !env.S3_SECRET_KEY) {
    if (production) {
      throw new StorageConfigError('faltan S3_ACCESS_KEY y S3_SECRET_KEY');
    }
    return null;
  }

  let endpoint = env.S3_ENDPOINT;
  if (!endpoint && provider === 'r2') {
    if (!env.R2_ACCOUNT_ID) {
      throw new StorageConfigError(
        'con STORAGE_PROVIDER=r2 hace falta R2_ACCOUNT_ID o S3_ENDPOINT',
      );
    }
    endpoint = `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
  }
  if (!endpoint && provider === 'minio') {
    throw new StorageConfigError('con STORAGE_PROVIDER=minio hace falta S3_ENDPOINT');
  }
  if (production && endpoint && !endpoint.startsWith('https://')) {
    throw new StorageConfigError('en producción el endpoint tiene que ser https://');
  }

  const bucket = env.S3_BUCKET ?? 'nexo';
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) {
    throw new StorageConfigError(`«${bucket}» no es un nombre de bucket válido`);
  }

  return {
    provider,
    endpoint,
    publicEndpoint: env.S3_PUBLIC_ENDPOINT ?? endpoint,
    region: env.S3_REGION ?? (provider === 'r2' ? 'auto' : 'us-east-1'),
    bucket,
    accessKeyId: env.S3_ACCESS_KEY,
    secretAccessKey: env.S3_SECRET_KEY,
    forcePathStyle: env.S3_FORCE_PATH_STYLE ?? provider === 'minio',
  };
}
