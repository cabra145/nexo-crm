/**
 * Autoprueba de @nexo/storage sin red: detección de tipos, claves por
 * empresa, configuración por proveedor y Content-Disposition.
 *
 *   pnpm --filter @nexo/storage selftest
 */
import {
  assertTenantKey,
  contentDisposition,
  resolveMime,
  resolveStorageConfig,
  sniffMime,
  StorageConfigError,
  tenantKey,
} from '../src';

let failed = 0;
let total = 0;
function check(name: string, ok: boolean, detail = ''): void {
  total += 1;
  if (!ok) failed += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? `  — ${detail}` : ''}`);
}
function throws(fn: () => unknown, type?: new (...a: never[]) => Error): boolean {
  try {
    fn();
    return false;
  } catch (error) {
    return !type || error instanceof type;
  }
}

const bytes = (...parts: Array<number[] | string>) =>
  Uint8Array.from(
    parts.flatMap((p) => (typeof p === 'string' ? [...p].map((c) => c.charCodeAt(0)) : p)),
  );
const pad = (b: Uint8Array) => Uint8Array.from([...b, ...new Array<number>(16).fill(0)]);

console.log('\nDetección del tipo real');
const cases: Array<[string, Uint8Array, string | null]> = [
  ['JPEG', pad(bytes([0xff, 0xd8, 0xff, 0xe0])), 'image/jpeg'],
  ['PNG', pad(bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), 'image/png'],
  ['WebP', pad(bytes('RIFF', [0, 0, 0, 0], 'WEBPVP8 ')), 'image/webp'],
  ['PDF', pad(bytes('%PDF-1.7')), 'application/pdf'],
  ['Ogg (nota de voz)', pad(bytes('OggS', [0])), 'audio/ogg'],
  ['MP3 con ID3', pad(bytes('ID3', [4, 0])), 'audio/mpeg'],
  ['AAC (ADTS)', pad(bytes([0xff, 0xf1, 0x50, 0x80])), 'audio/aac'],
  ['AMR', pad(bytes('#!AMR\n')), 'audio/amr'],
  ['MP4', pad(bytes([0, 0, 0, 0x18], 'ftypisom')), 'video/mp4'],
  ['M4A', pad(bytes([0, 0, 0, 0x18], 'ftypM4A ')), 'audio/mp4'],
  ['3GP', pad(bytes([0, 0, 0, 0x18], 'ftyp3gp4')), 'video/3gpp'],
  // TextEncoder, no `bytes()`: éste escribe un byte por carácter, y «ó» o «€»
  // no son UTF-8 así (el detector hacía bien en rechazarlo).
  ['texto UTF-8', new TextEncoder().encode('Cotización nº 12\nTotal: 50 €'), 'text/plain'],
  ['texto que no es UTF-8', bytes('Cotizaci', [0xf3], 'n'), null],
  ['HTML disfrazado no es imagen', bytes('<html><script>alert(1)</script>'), 'text/plain'],
  ['binario desconocido', bytes([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]), null],
];
for (const [name, input, expected] of cases) {
  const got = sniffMime(input);
  check(name, got === expected, `${got}`);
}

console.log('\nTipo declarado frente al detectado');
check(
  'docx: ZIP + tipo de Word declarado → Word',
  resolveMime(
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/zip',
  ) === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
);
check(
  'ZIP declarado como imagen → rechazado',
  resolveMime('image/jpeg', 'application/zip') === null,
);
check(
  'xls antiguo: OLE + Excel → Excel',
  resolveMime('application/vnd.ms-excel', 'application/x-ole-storage') ===
    'application/vnd.ms-excel',
);
check(
  'se guarda lo detectado, no lo declarado',
  resolveMime('image/png', 'image/jpeg') === 'image/jpeg',
);
check('sin tipo detectado → rechazado', resolveMime('application/pdf', null) === null);

console.log('\nClaves por empresa');
const tenant = '0190a3c2-1111-7000-8000-000000000001';
const other = '0190a3c2-2222-7000-8000-000000000002';
const key = tenantKey(tenant, 'whatsapp-media', 'jpg', new Date(Date.UTC(2026, 8, 17)));
check(
  'forma tenants/{empresa}/{propósito}/{año}/{mes}/{uuid}.{ext}',
  /^tenants\/0190a3c2-1111-7000-8000-000000000001\/whatsapp-media\/2026\/09\/[0-9a-f-]{36}\.jpg$/.test(
    key,
  ),
  key,
);
check(
  'dos claves nunca coinciden',
  tenantKey(tenant, 'attachment', 'pdf') !== tenantKey(tenant, 'attachment', 'pdf'),
);
check('la clave propia pasa', !throws(() => assertTenantKey(tenant, key)));
check(
  'la de otra empresa no',
  throws(() => assertTenantKey(other, key)),
);
check(
  'ni una que intenta salir con ..',
  throws(() => assertTenantKey(tenant, `tenants/${tenant}/../${other}/x.jpg`)),
);
check(
  'extensión rara rechazada',
  throws(() => tenantKey(tenant, 'attachment', 'php;.jpg')),
);
check(
  'empresa que no es UUID rechazada',
  throws(() => tenantKey('../../etc', 'attachment', 'txt')),
);

console.log('\nConfiguración por proveedor');
const keys = { S3_ACCESS_KEY: 'a', S3_SECRET_KEY: 'b' };
const r2 = resolveStorageConfig({ ...keys, R2_ACCOUNT_ID: 'abc123' });
check(
  'R2 por defecto: endpoint de la cuenta, región auto, sin rutas',
  r2?.provider === 'r2' &&
    r2.endpoint === 'https://abc123.r2.cloudflarestorage.com' &&
    r2.region === 'auto' &&
    !r2.forcePathStyle,
  JSON.stringify(r2),
);
const minio = resolveStorageConfig({
  ...keys,
  STORAGE_PROVIDER: 'minio',
  S3_ENDPOINT: 'http://127.0.0.1:9000',
});
check(
  'MinIO: rutas con el bucket y región estándar',
  minio?.forcePathStyle === true && minio.region === 'us-east-1',
);
const s3 = resolveStorageConfig({ ...keys, STORAGE_PROVIDER: 's3', S3_REGION: 'eu-west-1' });
check(
  'S3: sin endpoint (el de AWS) y la región indicada',
  s3 !== null && s3.endpoint === undefined && s3.region === 'eu-west-1',
);
check(
  'URL pública distinta de la interna (Docker)',
  resolveStorageConfig({
    ...keys,
    STORAGE_PROVIDER: 'minio',
    S3_ENDPOINT: 'http://minio:9000',
    S3_PUBLIC_ENDPOINT: 'http://localhost:9000',
  })?.publicEndpoint === 'http://localhost:9000',
);
check(
  'R2 sin cuenta ni endpoint → error claro',
  throws(() => resolveStorageConfig({ ...keys }), StorageConfigError),
);
check('sin credenciales en desarrollo → desactivado', resolveStorageConfig({}) === null);
check(
  'sin credenciales en producción → no arranca',
  throws(() => resolveStorageConfig({ NODE_ENV: 'production' }), StorageConfigError),
);
check(
  'en producción sólo https',
  throws(
    () =>
      resolveStorageConfig({
        ...keys,
        NODE_ENV: 'production',
        STORAGE_PROVIDER: 'minio',
        S3_ENDPOINT: 'http://minio:9000',
      }),
    StorageConfigError,
  ),
);
check(
  'bucket con nombre inválido → error',
  throws(
    () => resolveStorageConfig({ ...keys, R2_ACCOUNT_ID: 'x', S3_BUCKET: 'Mi_Bucket' }),
    StorageConfigError,
  ),
);

check(
  'en producción, http hacia la propia máquina sí (CI contra MinIO local)',
  resolveStorageConfig({
    ...keys,
    NODE_ENV: 'production',
    STORAGE_PROVIDER: 'minio',
    S3_ENDPOINT: 'http://127.0.0.1:9000',
  })?.endpoint === 'http://127.0.0.1:9000',
);
check(
  'en producción, la URL pública (la del navegador) también tiene que ser https',
  throws(
    () =>
      resolveStorageConfig({
        ...keys,
        NODE_ENV: 'production',
        R2_ACCOUNT_ID: 'abc',
        S3_PUBLIC_ENDPOINT: 'http://archivos.ejemplo.com',
      }),
    StorageConfigError,
  ),
);
check(
  'un host que sólo empieza por «localhost» no cuenta como local',
  throws(
    () =>
      resolveStorageConfig({
        ...keys,
        NODE_ENV: 'production',
        STORAGE_PROVIDER: 'minio',
        S3_ENDPOINT: 'http://localhost.atacante.com',
      }),
    StorageConfigError,
  ),
);
check('vida de las URL firmadas: 300 s por defecto', r2?.urlTtlSeconds === 300);
check(
  'vida de las URL firmadas fuera de 30–3600 → error',
  throws(
    () => resolveStorageConfig({ ...keys, R2_ACCOUNT_ID: 'x', STORAGE_URL_TTL_SECONDS: 86_400 }),
    StorageConfigError,
  ),
);

console.log('\nContent-Disposition');
const cd = contentDisposition('attachment', 'Cotización "final"\r\nX-Evil: 1.pdf');
check(
  'sin saltos de línea ni comillas que inyecten cabeceras',
  !/[\r\n]/.test(cd) && (cd.match(/"/g) ?? []).length === 2,
  cd,
);
check('nombre UTF-8 en filename*', cd.includes("filename*=UTF-8''Cotizaci%C3%B3n"), cd);
check(
  'conserva los espacios',
  contentDisposition('inline', 'mi foto.jpg').includes('filename="mi foto.jpg"'),
);

console.log(`\n${total - failed}/${total} comprobaciones superadas`);
if (failed) process.exitCode = 1;
else console.log('Almacenamiento: autoprueba superada.\n');
