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
  /** Booleano o su texto («true», «1»…): esto puede venir del entorno crudo. */
  S3_FORCE_PATH_STYLE?: boolean | string;
  STORAGE_URL_TTL_SECONDS?: number | string;
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
  /** Vida de las URL firmadas, en segundos. */
  urlTtlSeconds: number;
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
  const publicEndpoint = env.S3_PUBLIC_ENDPOINT ?? endpoint;
  if (production) {
    for (const [name, url] of [
      ['S3_ENDPOINT', endpoint],
      ['S3_PUBLIC_ENDPOINT', publicEndpoint],
    ] as const) {
      if (url && !isSecureUrl(url)) {
        throw new StorageConfigError(`en producción ${name} tiene que ser https:// (${url})`);
      }
    }
  }

  // Se normaliza aquí y no sólo en el esquema de entorno: este paquete lo
  // usan también scripts que leen `process.env` crudo, donde todo es texto.
  // Un booleano en texto llegaba tal cual al SDK, que construía un endpoint
  // inválido y el almacenamiento respondía 400 sin explicar nada.
  const urlTtlSeconds =
    env.STORAGE_URL_TTL_SECONDS === undefined || env.STORAGE_URL_TTL_SECONDS === ''
      ? 300
      : Number(env.STORAGE_URL_TTL_SECONDS);
  if (!Number.isInteger(urlTtlSeconds) || urlTtlSeconds < 30 || urlTtlSeconds > 3600) {
    throw new StorageConfigError('STORAGE_URL_TTL_SECONDS tiene que estar entre 30 y 3600');
  }

  const bucket = env.S3_BUCKET ?? 'nexo';
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) {
    throw new StorageConfigError(`«${bucket}» no es un nombre de bucket válido`);
  }

  return {
    provider,
    endpoint,
    publicEndpoint,
    region: env.S3_REGION ?? (provider === 'r2' ? 'auto' : 'us-east-1'),
    bucket,
    accessKeyId: env.S3_ACCESS_KEY,
    secretAccessKey: env.S3_SECRET_KEY,
    forcePathStyle: asBoolean(env.S3_FORCE_PATH_STYLE) ?? provider === 'minio',
    urlTtlSeconds,
  };
}

/** `true`, `'true'` y `'1'` son sí; `false`, `'false'` y `'0'`, no; vacío, sin decidir. */
function asBoolean(value: boolean | string | undefined): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (value === undefined || value.trim() === '') return undefined;
  return ['true', '1', 'yes'].includes(value.trim().toLowerCase());
}

/**
 * https, o http sólo hacia la propia máquina: los navegadores tratan
 * localhost como contexto seguro, y el CI prueba en modo producción contra un
 * MinIO local sin TLS. Un servidor real nunca tiene su almacenamiento ahí.
 */
function isSecureUrl(url: string): boolean {
  const parsed = new URL(url);
  if (parsed.protocol === 'https:') return true;
  return (
    parsed.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)
  );
}
