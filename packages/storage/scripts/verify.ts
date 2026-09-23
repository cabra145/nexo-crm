/**
 * Verifica el almacenamiento REAL que haya configurado el entorno: R2, S3 o
 * MinIO. Pensado para ejecutarlo antes de abrir un entorno a clientes y
 * después de cualquier cambio de bucket, token o CORS.
 *
 *   pnpm --filter @nexo/storage verify
 *
 * Qué hace y qué NO hace: escribe y borra UN objeto de prueba bajo
 * `tenants/00000000-0000-7000-8000-000000000000/…`, que no es de ninguna
 * empresa. No lee, ni lista, ni toca nada de los clientes. Nunca imprime
 * credenciales ni URL firmadas completas.
 */
import { createHash, randomUUID } from 'node:crypto';
import { createObjectStorage, resolveStorageConfig, type StorageConfig, tenantKey } from '../src';

const CHECK_TENANT = '00000000-0000-7000-8000-000000000000';

let failed = 0;
let total = 0;
function check(name: string, ok: boolean, detail = ''): boolean {
  total += 1;
  if (!ok) failed += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? `  — ${detail}` : ''}`);
  return ok;
}
const section = (title: string) => console.log(`\n${title}`);

/** Sólo el host: una URL firmada lleva credenciales en sus parámetros. */
const hostOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return '(URL inválida)';
  }
};

async function main(): Promise<void> {
  const source = process.env;
  let config: StorageConfig | null;
  try {
    config = resolveStorageConfig({
      NODE_ENV: source.NODE_ENV,
      STORAGE_PROVIDER: source.STORAGE_PROVIDER as StorageConfig['provider'] | undefined,
      R2_ACCOUNT_ID: source.R2_ACCOUNT_ID,
      S3_ENDPOINT: source.S3_ENDPOINT,
      S3_PUBLIC_ENDPOINT: source.S3_PUBLIC_ENDPOINT,
      S3_REGION: source.S3_REGION,
      S3_BUCKET: source.S3_BUCKET,
      S3_ACCESS_KEY: source.S3_ACCESS_KEY,
      S3_SECRET_KEY: source.S3_SECRET_KEY,
      S3_FORCE_PATH_STYLE:
        source.S3_FORCE_PATH_STYLE === undefined
          ? undefined
          : ['true', '1'].includes(source.S3_FORCE_PATH_STYLE),
      STORAGE_URL_TTL_SECONDS: source.STORAGE_URL_TTL_SECONDS
        ? Number(source.STORAGE_URL_TTL_SECONDS)
        : undefined,
    });
  } catch (error) {
    console.error(`\n✗ ${(error as Error).message}\n`);
    process.exit(1);
  }
  if (!config) {
    console.error('\n✗ Faltan S3_ACCESS_KEY y S3_SECRET_KEY: no hay nada que verificar.\n');
    process.exit(1);
  }

  const storage = createObjectStorage(source)!;
  const appOrigin = source.APP_URL ? new URL(source.APP_URL).origin : null;

  console.log(`\nVerificación del almacenamiento`);
  console.log(`  proveedor: ${config.provider}`);
  console.log(`  bucket:    ${config.bucket}`);
  console.log(`  servidor:  ${config.endpoint ? hostOf(config.endpoint) : '(el de AWS)'}`);
  console.log(
    `  navegador: ${config.publicEndpoint ? hostOf(config.publicEndpoint) : '(el de AWS)'}`,
  );
  console.log(`  URL firmadas: ${config.urlTtlSeconds} s`);

  const key = tenantKey(CHECK_TENANT, 'attachment', 'txt');
  const body = Buffer.from(`verificación ${randomUUID()}\n`);
  const sha256 = createHash('sha256').update(body).digest('hex');
  let uploaded = false;

  try {
    section('1 · Acceso');
    const access = await storage
      .checkAccess()
      .then(() => null)
      .catch((error: Error) => error.message);
    if (!check('el bucket existe y las credenciales dan acceso', access === null, access ?? '')) {
      // Sin acceso, el resto no aporta nada.
      console.log('\nNo se puede continuar sin acceso al bucket.\n');
      process.exit(1);
    }

    section('2 · Vuelta completa de un objeto');
    await storage.put({ key, body, contentType: 'text/plain', sha256 });
    uploaded = true;
    check('se puede escribir', true);
    const info = await storage.head(key);
    check(
      'se puede consultar, con el tamaño correcto',
      info?.sizeBytes === body.byteLength,
      `${info?.sizeBytes ?? '—'} bytes`,
    );
    const read = await storage.getBytes(key, 1024);
    check('se puede leer, y el contenido coincide', read.equals(body));
    const listed = await storage.listKeys(key.slice(0, key.lastIndexOf('/') + 1), 10);
    check('se puede listar por prefijo', listed.includes(key));

    section('3 · URL firmada de descarga');
    const url = await storage.signedGetUrl(key, {
      expiresInSeconds: config.urlTtlSeconds,
      contentType: 'text/plain',
      disposition: 'attachment',
      filename: 'verificación.txt',
    });
    check(
      'se firma desde el host que verá el navegador',
      hostOf(url) === hostOf(config.publicEndpoint ?? url),
      hostOf(url),
    );
    const signed = await fetch(url);
    const signedBody = Buffer.from(await signed.arrayBuffer());
    check(
      'la URL firmada sirve el objeto, con el tipo y el nombre que fija el servidor',
      signed.status === 200 &&
        signedBody.equals(body) &&
        (signed.headers.get('content-type') ?? '').startsWith('text/plain') &&
        (signed.headers.get('content-disposition') ?? '').startsWith('attachment'),
      `${signed.status} · ${signed.headers.get('content-disposition') ?? ''}`,
    );
    const tampered = await fetch(url.replace('attachment', 'inline'));
    await tampered.arrayBuffer();
    check('manipular la URL la invalida', tampered.status === 403, `${tampered.status}`);

    section('4 · El bucket NO es público');
    const naked = `${(config.publicEndpoint ?? '').replace(/\/$/, '')}/${config.forcePathStyle ? `${config.bucket}/` : ''}${key}`;
    const anonymous = await fetch(naked).catch(() => null);
    await anonymous?.arrayBuffer();
    check(
      'sin firma no se sirve nada',
      anonymous !== null && [401, 403, 404].includes(anonymous.status),
      anonymous ? `respondió ${anonymous.status}` : 'no se pudo comprobar',
    );

    section('5 · URL firmada de subida');
    const putKey = tenantKey(CHECK_TENANT, 'attachment', 'txt');
    const putUrl = await storage.signedPutUrl(putKey, {
      expiresInSeconds: config.urlTtlSeconds,
      contentType: 'text/plain',
      contentLength: body.byteLength,
    });
    const put = await fetch(putUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'text/plain' },
      body: new Uint8Array(body),
    });
    await put.arrayBuffer();
    if (check('se puede subir con la URL firmada', put.status === 200, `${put.status}`)) {
      await storage.delete([putKey]);
    }
    const wrongSize = await fetch(putUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'text/plain' },
      body: new Uint8Array(Buffer.concat([body, Buffer.from('de más')])),
    });
    await wrongSize.arrayBuffer();
    check(
      'subir otro tamaño con esa firma se rechaza',
      wrongSize.status === 403,
      `${wrongSize.status}`,
    );

    section('6 · CORS para la web');
    if (!appOrigin) {
      check('APP_URL no está definida: no se puede comprobar CORS', false);
    } else {
      // La misma comprobación previa que hace el navegador antes de un PUT.
      const preflight = await fetch(putUrl, {
        method: 'OPTIONS',
        headers: {
          Origin: appOrigin,
          'Access-Control-Request-Method': 'PUT',
          'Access-Control-Request-Headers': 'content-type',
        },
      }).catch(() => null);
      const allowed = preflight?.headers.get('access-control-allow-origin');
      check(
        `el bucket permite subir desde ${appOrigin}`,
        preflight !== null && preflight.status < 400 && (allowed === appOrigin || allowed === '*'),
        preflight ? `${preflight.status} · allow-origin: ${allowed ?? 'ninguno'}` : 'sin respuesta',
      );
      const getPreflight = await fetch(url, {
        method: 'OPTIONS',
        headers: { Origin: appOrigin, 'Access-Control-Request-Method': 'GET' },
      }).catch(() => null);
      const getAllowed = getPreflight?.headers.get('access-control-allow-origin');
      check(
        'y descargar (las imágenes del hilo se piden desde el navegador)',
        getPreflight !== null &&
          getPreflight.status < 400 &&
          (getAllowed === appOrigin || getAllowed === '*'),
        getPreflight
          ? `${getPreflight.status} · allow-origin: ${getAllowed ?? 'ninguno'}`
          : 'sin respuesta',
      );
    }

    section('7 · Caducidad');
    const shortLived = await storage.signedGetUrl(key, {
      expiresInSeconds: 1,
      contentType: 'text/plain',
      disposition: 'attachment',
      filename: 'verificación.txt',
    });
    await new Promise((r) => setTimeout(r, 2000));
    const expired = await fetch(shortLived);
    await expired.arrayBuffer();
    check('una URL caducada deja de servir', expired.status === 403, `${expired.status}`);
  } finally {
    if (uploaded) {
      await storage
        .delete([key])
        .catch((error: Error) =>
          console.error(`  ! no se pudo borrar el objeto de prueba: ${error.message}`),
        );
    }
  }

  console.log(`\n${total - failed}/${total} comprobaciones superadas`);
  if (failed) {
    console.error('\nAlmacenamiento NO listo. Revisa docs/despliegue-r2.md.\n');
    process.exit(1);
  }
  console.log('Almacenamiento verificado.\n');
}

main().catch((error: unknown) => {
  console.error(`\n✗ ${(error as Error).message}\n`);
  process.exit(1);
});
