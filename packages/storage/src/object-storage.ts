import type { Readable } from 'node:stream';

/**
 * Almacenamiento de objetos, sin proveedor.
 *
 * La lógica de negocio sólo conoce esta interfaz. Hoy la implementa
 * `S3ObjectStorage`, que habla la API S3 con cualquiera de los proveedores
 * compatibles (Cloudflare R2, Amazon S3, MinIO): cambiar de uno a otro es
 * cambiar variables de entorno, no código.
 *
 * Las claves son opacas para esta capa. Quién puede tocar qué clave lo
 * deciden `tenantKey`/`assertTenantKey` (keys.ts) y, antes, la fila `File`
 * leída con el aislamiento por empresa de la base de datos.
 */
export interface ObjectStorage {
  /** Nombre del bucket, para guardarlo junto a cada archivo. */
  readonly bucket: string;

  /** Sube un objeto completo. */
  put(input: PutObjectInput): Promise<void>;

  /** Metadatos del objeto, o null si no existe. */
  head(key: string): Promise<ObjectInfo | null>;

  /** Contenido completo. Para objetos acotados (los límites los pone la política). */
  getBytes(key: string, maxBytes: number): Promise<Buffer>;

  /** Los primeros `length` bytes: para detectar el tipo real sin bajar el archivo. */
  getRange(key: string, length: number): Promise<Buffer>;

  /** Contenido como flujo, para reenviarlo sin cargarlo en memoria. */
  getStream(key: string): Promise<Readable>;

  delete(keys: string[]): Promise<void>;

  /** URL firmada de descarga, de vida corta. */
  signedGetUrl(key: string, options: SignedGetOptions): Promise<string>;

  /**
   * URL firmada de subida directa desde el navegador. Firma el tipo y el
   * tamaño exactos: con otros, el proveedor rechaza la subida.
   */
  signedPutUrl(key: string, options: SignedPutOptions): Promise<string>;
}

export interface PutObjectInput {
  key: string;
  body: Buffer | Uint8Array;
  contentType: string;
  /** SHA-256 en hexadecimal, guardado como metadato del objeto. */
  sha256?: string;
}

export interface ObjectInfo {
  sizeBytes: number;
  contentType: string | null;
}

export interface SignedGetOptions {
  expiresInSeconds: number;
  /** Tipo con el que se sirve: el que detectamos, no el que diga el objeto. */
  contentType: string;
  /** `inline` para verlo en el navegador; `attachment` para descargarlo. */
  disposition: 'inline' | 'attachment';
  /** Nombre que verá quien lo descargue. */
  filename: string;
}

export interface SignedPutOptions {
  expiresInSeconds: number;
  contentType: string;
  contentLength: number;
}

/** El objeto no existe (o no en esa clave). */
export class ObjectNotFoundError extends Error {
  constructor(readonly key: string) {
    super(`No existe el objeto ${key}`);
    this.name = 'ObjectNotFoundError';
  }
}

/** El objeto supera el tamaño que se estaba dispuesto a leer. */
export class ObjectTooLargeError extends Error {
  constructor(
    readonly key: string,
    readonly maxBytes: number,
  ) {
    super(`El objeto ${key} supera ${maxBytes} bytes`);
    this.name = 'ObjectTooLargeError';
  }
}
