# Almacenamiento en producción: Cloudflare R2

Guía para poner en producción el almacenamiento de archivos del bloque 2.3a:
adjuntos de WhatsApp (los que envían los clientes y los que envía el agente).

Nexo habla la API S3 estándar a través de `@nexo/storage`, así que esta guía
sirve casi igual para Amazon S3 o MinIO: cambian el endpoint, la región y el
estilo de ruta, no el código. R2 es el proveedor por defecto porque no cobra
por descarga, y las descargas (imágenes de conversaciones) son la operación
más frecuente.

**Antes de empezar, dos cosas que el sistema da por hechas:**

- El bucket es **privado**. Todo se sirve con URL firmadas de vida corta; no
  se usa dominio público ni acceso anónimo.
- Las claves llevan el prefijo de la empresa
  (`tenants/{empresa}/{propósito}/{año}/{mes}/{uuid}.{ext}`). No se cambia el
  esquema de claves después de tener datos: las filas de `file` guardan la
  clave exacta.

---

## 1 · Crear el bucket

En el panel de Cloudflare → **R2** → _Create bucket_:

| Campo          | Valor                                                           |
| -------------- | --------------------------------------------------------------- |
| Nombre         | `nexo-prod` (minúsculas, sin guiones bajos)                     |
| Ubicación      | La más cercana a los clientes; `ENAM`/`WNAM` para Latinoamérica |
| Acceso público | **Desactivado**. Sin dominio público ni `r2.dev`                |
| Jurisdicción   | La que exija el cumplimiento normativo del negocio, si aplica   |

Anota el **Account ID** de R2 (aparece en la barra lateral): con él, Nexo
deduce el endpoint `https://<ACCOUNT_ID>.r2.cloudflarestorage.com`.

No hace falta crear carpetas: las claves las genera la aplicación.

> El script `pnpm --filter @nexo/storage ensure-bucket` **sólo** actúa sobre
> MinIO, a propósito: crear buckets exigiría dar a la aplicación permisos de
> administración que no necesita para nada más.

### Ciclo de vida (opcional, recomendado)

En _Settings → Object lifecycle rules_, una regla de **abort de subidas
multiparte incompletas a los 7 días**. Nexo no usa multiparte hoy, pero es la
única basura que la limpieza de la aplicación no puede ver.

No se configuran reglas de borrado por antigüedad: el contenido de las
conversaciones de un cliente no caduca solo. La retención por empresa, cuando
exista, se decidirá con la facturación (Fase 5).

---

## 2 · Token y claves

En **R2 → Manage API Tokens → Create API Token**:

| Campo               | Valor                                                             |
| ------------------- | ----------------------------------------------------------------- |
| Nombre              | `nexo-prod-api` (uno por entorno; no reutilizar el de pruebas)    |
| Permiso             | **Object Read & Write** (no _Admin_, no _Read & Write_ de cuenta) |
| Alcance             | **Apply to specific buckets** → sólo `nexo-prod`                  |
| TTL                 | Sin caducidad, o con recordatorio de rotación                     |
| Client IP filtering | Las IP de salida de los servidores, si son fijas                  |

Al crearlo, Cloudflare muestra **una sola vez** el `Access Key ID` y el
`Secret Access Key`: son `S3_ACCESS_KEY` y `S3_SECRET_KEY`.

**Permisos mínimos que Nexo necesita** (todos sobre objetos de ese bucket):

| Operación S3      | Para qué                                                    |
| ----------------- | ----------------------------------------------------------- |
| `PutObject`       | Guardar lo que envían los clientes y las subidas del agente |
| `GetObject`       | Descargar para reenviar a Meta, y comprobar tipo y tamaño   |
| `HeadObject`      | Comprobar una subida antes de aceptarla                     |
| `DeleteObject(s)` | Rechazos y limpieza de subidas abandonadas                  |
| `ListObjectsV2`   | Limpieza y comprobaciones de consistencia                   |
| `HeadBucket`      | Sonda de arranque y `/health/ready`                         |

Nexo **no** necesita `CreateBucket`, `DeleteBucket`, ni permisos de cuenta.

**Dónde viven las claves:** en el gestor de secretos del despliegue (variables
de entorno del servicio), nunca en el repositorio. `.env` está en
`.gitignore`; `.env.example` sólo lleva valores de desarrollo.

---

## 3 · Variables de entorno

Las mismas para la API y el worker (`packages/contracts/src/env.ts`):

```bash
STORAGE_PROVIDER=r2
R2_ACCOUNT_ID=<32 caracteres hexadecimales del panel de R2>
S3_BUCKET=nexo-prod
S3_ACCESS_KEY=<Access Key ID del token>
S3_SECRET_KEY=<Secret Access Key del token>

# Opcionales: con r2 se deducen (endpoint de la cuenta, región «auto»,
# rutas virtuales). Sólo se fijan si hay un motivo concreto.
# S3_ENDPOINT=
# S3_PUBLIC_ENDPOINT=      # si el navegador llega por otra URL que el servidor
# S3_REGION=
# S3_FORCE_PATH_STYLE=

# Vida de las URL firmadas (30–3600). 300 s es suficiente para abrir o
# descargar, y corto para que una URL filtrada sirva de poco.
STORAGE_URL_TTL_SECONDS=300

# Horas que sobrevive una subida reservada y nunca enviada.
STORAGE_PENDING_TTL_HOURS=24
```

Sólo en el **worker**, para los archivos que envían los clientes:

```bash
# Dominios desde los que se descargan archivos de Meta. El valor por defecto
# es el correcto en producción; se cambia sólo si Meta cambia de dominio.
META_MEDIA_HOSTS=lookaside.fbsbx.com
```

En producción, sin credenciales o con un endpoint que no sea `https`, **la API
y el worker no arrancan**: es deliberado, y el CI lo prueba en cada ejecución.

---

## 4 · CORS

El navegador sube el archivo **directo a R2** y muestra las imágenes desde R2,
así que el bucket necesita CORS. En **R2 → el bucket → Settings → CORS
Policy**:

```json
[
  {
    "AllowedOrigins": ["https://app.tu-dominio.com"],
    "AllowedMethods": ["GET", "PUT", "HEAD"],
    "AllowedHeaders": ["content-type"],
    "ExposeHeaders": ["etag"],
    "MaxAgeSeconds": 3600
  }
]
```

- **`AllowedOrigins`**: exactamente el origen de la web (el mismo `APP_URL`),
  sin comodín. Un `*` permitiría que cualquier página iniciara subidas con una
  URL firmada robada.
- **`PUT`** es la subida del agente; **`GET`** y **`HEAD`**, las imágenes, el
  audio y el vídeo del hilo.
- **`AllowedHeaders: content-type`**: el `PUT` firmado envía esa cabecera y no
  otras. Sin esto, el navegador falla en la comprobación previa (preflight).

En desarrollo, MinIO acepta cualquier origen: no hay nada que configurar.

---

## 5 · Checklist de despliegue

1. [ ] Bucket `nexo-prod` creado, **privado**, sin dominio público.
2. [ ] Token `Object Read & Write` limitado a ese bucket; claves guardadas en
       el gestor de secretos.
3. [ ] CORS aplicado con el origen exacto de la web.
4. [ ] Variables del punto 3 puestas en **API y worker** (las dos: el worker
       también sube y descarga).
5. [ ] `META_MEDIA_HOSTS` en el worker.
6. [ ] Migraciones aplicadas (`pnpm db:migrate`): el bloque 2.3a añadió
       `file.status`, `ready_at`, `reject_reason` y las claves foráneas
       compuestas de `message_media`.
7. [ ] Despliegue de API y worker **a la vez**: el worker escribe archivos que
       la API firma, y ambos comparten los contratos.
8. [ ] Arranque verificado en los registros: la API escribe
       `Almacenamiento · r2 · bucket «nexo-prod»`; el worker,
       `Almacenamiento disponible`. Si no arrancan, el mensaje dice qué falta.

---

## 6 · Checklist de validación posterior

Con una conversación real (se puede usar el número de pruebas de Meta):

1. [ ] `GET /api/v1/health/ready` → `200` y `"storage": { "status": "up" }`.
       La sonda es pública: comprueba que **no** aparece el nombre del bucket.
2. [ ] Un cliente envía una **foto**: aparece en la bandeja en segundos y se
       ve. En el registro del worker, `Archivo guardado`.
3. [ ] Un cliente envía un **PDF**: la tarjeta muestra el nombre, y
       «Descargar» lo entrega con ese nombre.
4. [ ] El agente **adjunta** una imagen y un PDF: llegan al WhatsApp del
       cliente, con su pie de foto.
5. [ ] En R2, las claves nuevas cuelgan de `tenants/<empresa>/whatsapp-media/`.
6. [ ] Abrir la URL firmada de una imagen en una ventana privada: funciona.
       Pasados 5 minutos, la misma URL devuelve `403`.
7. [ ] Quitar un parámetro de esa URL (por ejemplo la firma): `403`.
8. [ ] Con una segunda empresa, pedir el archivo de la primera: `404`.
9. [ ] Un agente sube algo y no lo envía: al día siguiente, ni la fila ni el
       objeto siguen ahí (limpieza aplazada).
10. [ ] Revisar `file` en la base: sin filas `PENDING` viejas ni `REJECTED`
        con objeto en el bucket.

---

## 7 · Riesgos conocidos

| Riesgo                                                                                                                              | Mitigación / estado                                                                                                                                               |
| ----------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Cambiar `S3_BUCKET` con datos ya guardados**: las filas guardan la clave, y se firmarían contra el bucket nuevo → descargas rotas | No se cambia. Para migrar de bucket hay que copiar los objetos y actualizar `file.bucket`; hoy no hay procedimiento automatizado                                  |
| **Una URL firmada filtrada** (captura, historial, registro de un proxy) permite leer ESE archivo hasta que caduque                  | 5 minutos de vida, un solo objeto por firma, y ni la API ni el worker registran URLs. Para revocar al instante haría falta servir por proxy, que se descartó      |
| **Sin antivirus**: un archivo puede contener malware; Nexo comprueba el tipo real, no el contenido                                  | Los documentos siempre se **descargan**, nunca se abren desde el dominio del almacenamiento. `file.scan_status` queda como `SKIPPED` para integrarlo después      |
| **Sin cuota de almacenamiento por empresa**                                                                                         | Límite de 10 subidas pendientes por persona y límites de tamaño por archivo. La cuota por plan se decidirá con la facturación (Fase 5)                            |
| **Objetos huérfanos por un fallo entre subir y guardar la fila**                                                                    | La aplicación borra el objeto en el momento; si ese borrado también falla, queda un objeto invisible. Un barrido global exige la identidad de plataforma (Fase 6) |
| **El token de R2 se filtra**                                                                                                        | Sólo da acceso a ese bucket. Rotación: crear un token nuevo, actualizar las variables, reiniciar API y worker, borrar el antiguo                                  |
| **Meta cambia el dominio de descarga** de archivos                                                                                  | Las descargas fallan con «dominio no permitido» y el motivo queda en la conversación; se corrige añadiendo el dominio a `META_MEDIA_HOSTS`                        |
| **R2 caído**                                                                                                                        | La bandeja sigue funcionando: sólo fallan los archivos. `/health/ready` lo informa sin marcar la API como no disponible                                           |

---

## 8 · Rollback

**Si falla el despliegue (la API o el worker no arrancan).** Lo más probable es
una variable mal puesta; el mensaje de arranque dice cuál. Si hay que volver
atrás:

1. Desplegar la versión anterior de API y worker.
2. **No** hay que revertir la migración: `file.status` tiene valor por defecto
   y las claves foráneas compuestas no estorban al código antiguo.
3. Los archivos guardados en R2 durante la ventana quedan ahí; sus filas
   también. Al volver a desplegar, siguen funcionando.

**Si hay que revertir la migración de todos modos** (última opción, con
copia de seguridad previa):

```sql
ALTER TABLE message_media DROP CONSTRAINT message_media_tenant_id_file_id_fkey;
ALTER TABLE message_media DROP CONSTRAINT message_media_tenant_id_message_id_fkey;
ALTER TABLE message_media
  ADD CONSTRAINT message_media_message_id_fkey
  FOREIGN KEY (message_id) REFERENCES message(id) ON DELETE CASCADE;
ALTER TABLE message_media
  ADD CONSTRAINT message_media_file_id_fkey
  FOREIGN KEY (file_id) REFERENCES file(id) ON DELETE SET NULL;
ALTER TABLE file DROP COLUMN status, DROP COLUMN ready_at, DROP COLUMN reject_reason;
DELETE FROM _prisma_migrations WHERE migration_name LIKE '%archivos_estado_y_misma_empresa';
```

Devuelve el agujero entre empresas que esas claves compuestas cierran: sólo
con la aplicación detenida y por poco tiempo.

**Si sólo hay que desactivar los archivos** sin tocar el resto del producto:
quitar `S3_ACCESS_KEY` y `S3_SECRET_KEY` **no** sirve en producción (los
procesos no arrancarían). La vía es desplegar la versión anterior al bloque
2.3a, o apuntar a un bucket vacío: las conversaciones y los mensajes siguen
intactos, y los archivos anteriores dejarían de verse hasta restaurar el
bucket original.

**Rotación de claves sin cortar el servicio:** crear el token nuevo, actualizar
las variables y reiniciar primero el worker y después la API (o al revés: son
independientes). Las URL firmadas con la clave anterior siguen siendo válidas
hasta que caduquen, como máximo 5 minutos.
