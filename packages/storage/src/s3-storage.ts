import type { Readable } from 'node:stream';
import {
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  NoSuchKey,
  NotFound,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { StorageConfig, StorageProvider } from './config';
import {
  type ObjectInfo,
  ObjectNotFoundError,
  type ObjectStorage,
  ObjectTooLargeError,
  type PutObjectInput,
  type SignedGetOptions,
  type SignedPutOptions,
  StorageAccessError,
} from './object-storage';

/** Una URL firmada nunca vive más de esto, se pida lo que se pida. */
const MAX_SIGNED_URL_SECONDS = 60 * 60;

/**
 * `ObjectStorage` sobre la API S3: Cloudflare R2, Amazon S3 o MinIO.
 *
 * Dos clientes: uno para las operaciones del servidor y otro sólo para FIRMAR
 * URLs con el endpoint que ve el navegador (el host forma parte de la firma).
 * Firmar es un cálculo local: el segundo cliente nunca abre conexiones.
 */
export class S3ObjectStorage implements ObjectStorage {
  readonly bucket: string;
  readonly provider: StorageProvider;
  readonly urlTtlSeconds: number;
  private readonly client: S3Client;
  private readonly signer: S3Client;

  constructor(config: StorageConfig) {
    this.bucket = config.bucket;
    this.provider = config.provider;
    this.urlTtlSeconds = config.urlTtlSeconds;
    const base = {
      region: config.region,
      forcePathStyle: config.forcePathStyle,
      credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
      // Las sumas CRC que el SDK añade por defecto desde 2025 no las admiten
      // todos los compatibles con S3 (R2 y MinIO las rechazaban en URLs
      // firmadas). Sólo cuando la operación las exige.
      requestChecksumCalculation: 'WHEN_REQUIRED' as const,
      responseChecksumValidation: 'WHEN_REQUIRED' as const,
      maxAttempts: 3,
    };
    this.client = new S3Client({ ...base, endpoint: config.endpoint });
    this.signer = new S3Client({ ...base, endpoint: config.publicEndpoint });
  }

  async checkAccess(): Promise<void> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
    } catch (error) {
      const status =
        error instanceof S3ServiceException ? error.$metadata.httpStatusCode : undefined;
      const reason =
        status === 404
          ? 'el bucket no existe'
          : status === 403
            ? 'las credenciales no dan acceso al bucket'
            : (error as Error).message;
      throw new StorageAccessError(this.bucket, reason);
    }
  }

  async put(input: PutObjectInput): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: input.key,
        Body: input.body,
        ContentType: input.contentType,
        ContentLength: input.body.byteLength,
        ...(input.sha256 ? { Metadata: { sha256: input.sha256 } } : {}),
      }),
    );
  }

  async head(key: string): Promise<ObjectInfo | null> {
    try {
      const res = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return { sizeBytes: res.ContentLength ?? 0, contentType: res.ContentType ?? null };
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async getBytes(key: string, maxBytes: number): Promise<Buffer> {
    const stream = await this.getStream(key);
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of stream) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      total += buf.byteLength;
      if (total > maxBytes) {
        stream.destroy();
        throw new ObjectTooLargeError(key, maxBytes);
      }
      chunks.push(buf);
    }
    return Buffer.concat(chunks);
  }

  async getRange(key: string, length: number): Promise<Buffer> {
    try {
      const res = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key, Range: `bytes=0-${length - 1}` }),
      );
      return Buffer.from(await res.Body!.transformToByteArray());
    } catch (error) {
      if (isNotFound(error)) throw new ObjectNotFoundError(key);
      throw error;
    }
  }

  async getStream(key: string): Promise<Readable> {
    try {
      const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      return res.Body as Readable;
    } catch (error) {
      if (isNotFound(error)) throw new ObjectNotFoundError(key);
      throw error;
    }
  }

  async delete(keys: string[]): Promise<void> {
    // DeleteObjects admite hasta 1000 claves por petición.
    for (let i = 0; i < keys.length; i += 1000) {
      const batch = keys.slice(i, i + 1000);
      if (batch.length === 0) continue;
      await this.client.send(
        new DeleteObjectsCommand({
          Bucket: this.bucket,
          Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: true },
        }),
      );
    }
  }

  async listKeys(prefix: string, limit = 10_000): Promise<string[]> {
    const keys: string[] = [];
    let token: string | undefined;
    do {
      const res = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix,
          ContinuationToken: token,
          MaxKeys: Math.min(1000, limit - keys.length),
        }),
      );
      for (const item of res.Contents ?? []) if (item.Key) keys.push(item.Key);
      token = res.IsTruncated ? res.NextContinuationToken : undefined;
    } while (token && keys.length < limit);
    return keys;
  }

  signedGetUrl(key: string, options: SignedGetOptions): Promise<string> {
    return getSignedUrl(
      this.signer,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        // El tipo y la forma de entrega los decide el servidor, no el objeto:
        // un archivo subido como «imagen» no se sirve nunca como HTML.
        ResponseContentType: options.contentType,
        ResponseContentDisposition: contentDisposition(options.disposition, options.filename),
        ResponseCacheControl: 'private, max-age=300',
      }),
      { expiresIn: clampTtl(options.expiresInSeconds) },
    );
  }

  signedPutUrl(key: string, options: SignedPutOptions): Promise<string> {
    return getSignedUrl(
      this.signer,
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ContentType: options.contentType,
        ContentLength: options.contentLength,
      }),
      {
        expiresIn: clampTtl(options.expiresInSeconds),
        // Tipo y tamaño dentro de la firma: una subida con otros no vale.
        signableHeaders: new Set(['content-type', 'content-length']),
      },
    );
  }
}

function clampTtl(seconds: number): number {
  return Math.max(1, Math.min(Math.floor(seconds), MAX_SIGNED_URL_SECONDS));
}

function isNotFound(error: unknown): boolean {
  return (
    error instanceof NoSuchKey ||
    error instanceof NotFound ||
    (error instanceof S3ServiceException && error.$metadata.httpStatusCode === 404)
  );
}

/**
 * Content-Disposition con el nombre en ASCII seguro y en UTF-8 (RFC 6266 y
 * 5987): «Cotización ñandú.pdf» llega bien a cualquier navegador, y un nombre
 * con comillas o saltos de línea no puede inyectar cabeceras.
 */
export function contentDisposition(type: 'inline' | 'attachment', filename: string): string {
  const clean =
    [...filename]
      .filter((c) => {
        const code = c.charCodeAt(0);
        return code >= 0x20 && code !== 0x7f && !'"\\/'.includes(c);
      })
      .join('')
      .trim() || 'archivo';
  const ascii =
    clean
      .normalize('NFD')
      .replace(/[^\x20-\x7e]/g, '')
      .replace(/[%;]/g, '') || 'archivo';
  const encoded = encodeURIComponent(clean).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `${type}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}
