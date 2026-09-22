/**
 * Crea el bucket si no existe. SÓLO para MinIO (desarrollo y CI).
 *
 * En R2 y S3 el bucket se crea a mano, con su política y su CORS revisados
 * (ver docs/arquitectura.md): que una aplicación cree buckets en producción
 * exigiría darle permisos de administración que no necesita para nada más.
 *
 *   pnpm --filter @nexo/storage ensure-bucket
 */
import {
  BucketAlreadyOwnedByYou,
  CreateBucketCommand,
  HeadBucketCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { resolveStorageConfig } from '../src';

async function main(): Promise<void> {
  const config = resolveStorageConfig({
    NODE_ENV: process.env.NODE_ENV,
    STORAGE_PROVIDER: process.env.STORAGE_PROVIDER as 'minio' | undefined,
    S3_ENDPOINT: process.env.S3_ENDPOINT,
    S3_BUCKET: process.env.S3_BUCKET,
    S3_REGION: process.env.S3_REGION,
    S3_ACCESS_KEY: process.env.S3_ACCESS_KEY,
    S3_SECRET_KEY: process.env.S3_SECRET_KEY,
  });
  if (!config) throw new Error('Faltan S3_ACCESS_KEY y S3_SECRET_KEY');
  if (config.provider !== 'minio') {
    throw new Error(`Sólo crea buckets en MinIO; en ${config.provider} se crean a mano`);
  }

  const client = new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    forcePathStyle: true,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
  });

  // MinIO tarda unos segundos en aceptar peticiones tras arrancar.
  for (let attempt = 1; ; attempt++) {
    try {
      await client.send(new HeadBucketCommand({ Bucket: config.bucket }));
      console.log(`Bucket «${config.bucket}» listo (ya existía)`);
      return;
    } catch (error) {
      const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata
        ?.httpStatusCode;
      if (status === 404) break;
      if (attempt >= 30) throw error;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  try {
    await client.send(new CreateBucketCommand({ Bucket: config.bucket }));
  } catch (error) {
    if (!(error instanceof BucketAlreadyOwnedByYou)) throw error;
  }
  // MinIO crea los buckets privados: sin política, sólo se entra con firma.
  console.log(`Bucket «${config.bucket}» creado, privado`);
}

main().catch((error: unknown) => {
  console.error((error as Error).message);
  process.exit(1);
});
