# Arquitectura

Versión navegable, con diagramas:
**<https://claude.ai/code/artifact/5700f054-f5b9-4489-87d2-e6be8b4e436a>**

Este documento es el registro _en el repositorio_: las decisiones que gobiernan
el código, y las correcciones que aparecieron al implementarlas.

---

## Decisiones que definen el sistema

| Decisión         | Elegido                                   | Descartado y por qué                                                                                                      |
| ---------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Aislamiento      | BD compartida + `tenant_id` + RLS forzada | Un esquema por empresa: migrar miles de esquemas es inviable. BD por empresa: coste desproporcionado hasta facturar mucho |
| Repositorio      | Monorepo pnpm + Turborepo                 | Repos separados: los tipos entre API y web se desincronizan                                                               |
| Sesión           | Cookie `httpOnly` + refresh rotativo      | JWT en `localStorage`: cualquier XSS se lleva la sesión entera                                                            |
| Búsqueda         | `pg_trgm` + `tsvector` nativos            | Elasticsearch: un servicio más que operar y sincronizar sin necesidad aún                                                 |
| Embeddings       | `pgvector` en la misma base               | Pinecone/Qdrant: una segunda superficie donde podrían filtrarse datos entre empresas                                      |
| Colas            | BullMQ sobre Redis                        | Cron dentro de la API: no sobrevive a reinicios ni escala sin duplicar ejecuciones                                        |
| Tiempo real      | Socket.IO + adaptador Redis               | Polling: latencia y coste. SSE: unidireccional, no sirve para acuses ni "escribiendo…"                                    |
| Automatizaciones | Intérprete de grafos propio               | n8n/Temporal embebidos: imponen su modelo de datos y su interfaz                                                          |
| PDF              | React → HTML → Puppeteer                  | Librerías por coordenadas: cada cambio de plantilla es aritmética a mano                                                  |
| Estado cliente   | React Query (servidor) + Zustand (UI)     | Redux global con datos del servidor: invalidación manual y el triple de código                                            |

---

## Las tres capas de aislamiento

1. **Contexto de petición** — `AsyncLocalStorage` (`packages/database/src/tenant-context.ts`)
2. **Extensión de Prisma** — inyecta `tenantId` en `where` y `data` (`packages/database/src/client.ts`)
3. **Row Level Security** — políticas en Postgres (`packages/database/prisma/sql/01_rls.sql`)

Las dos primeras son de aplicación y dan _corrección_. La tercera da
_seguridad_: no se puede saltar desde el código porque la aplicación conecta
con un rol sin `BYPASSRLS` que no es dueño de las tablas.

Ninguna de las tres lleva una lista escrita a mano. La capa 2 deriva los
modelos protegidos del DMMF de Prisma; la capa 3 recorre el catálogo de
Postgres. Añadir un modelo con `tenantId` basta para quedar cubierto, y
`verify_tenant_isolation()` aborta el despliegue si algo quedó fuera.

---

## Correcciones al plan original

Cosas que el documento de arquitectura daba por hechas y que al implementarlas
resultaron ser distintas. Se anotan aquí y no se corrigen en silencio.

### El recuento de tablas era 58; son 66

El plan sumó mal los dominios. El desglose real:

| Dominio                     | Tablas |
| --------------------------- | -----: |
| Plataforma                  |      7 |
| Identidad y acceso          |      9 |
| CRM                         |      8 |
| Ventas                      |      7 |
| Conversaciones              |      7 |
| Inteligencia artificial     |      6 |
| Automatizaciones            |      5 |
| Documentos comerciales      |      6 |
| Agenda y tareas             |      5 |
| Analítica e infraestructura |      6 |
| **Total**                   | **66** |

De ellas, **55 llevaban `tenant_id` obligatorio** y política RLS en la Fase 0 (el
plan decía 41); **57 desde el bloque 1.1**. `tenant` tiene política propia contra su clave primaria, y 10 quedan fuera
por motivos escritos en `_rls_excluded_tables()`.

### Con RLS forzada, nadie podía crear una empresa

Una política única `FOR ALL` sobre `tenant` cuyo `WITH CHECK` exigiera
`id = current_tenant_id()` hace el registro **imposible**: al darse de alta
todavía no existe la empresa cuyo contexto habría que fijar. El seed tampoco
podía arrancar.

Corregido separando el `INSERT` del resto: crear una empresa se permite
siempre, y `SELECT` / `UPDATE` / `DELETE` siguen restringidos a la fila propia.
Cualquiera puede registrarse; nadie puede leer ni tocar la empresa de otro.

### Alta de empresas sin privilegios — resuelto en el bloque 1.1

El `INSERT … RETURNING` que usa Prisma exige que la fila devuelta pase la
política de **lectura** de `tenant`, que sólo deja ver la empresa del contexto.
Al registrarse no parecía haber contexto, así que la Fase 0 permitió el INSERT
sin condición (`WITH CHECK (true)`) y anotó que el registro necesitaría una vía
privilegiada.

No hace falta. El id de la empresa se genera **antes** de insertarla
(`SELECT uuid_generate_v7()`), se fija como contexto y se inserta con ese id: la
fila pasa la política como cualquier otra. `runInNewTenantTransaction()`
encapsula el patrón, corre con el rol de aplicación sin permisos especiales, y
la política de INSERT vuelve a ser estricta: `WITH CHECK (id = current_tenant_id())`.

El **panel de plataforma** sí necesita leer todas las empresas, así que ahí la
vía privilegiada es inevitable. Se diseña en la Fase 6, con una restricción a
tener en cuenta: en Postgres gestionado (AWS RDS y similares) normalmente no se
puede crear un rol con `BYPASSRLS`; puede requerir funciones `SECURITY DEFINER`
acotadas a las consultas del panel.

### `role_permission` y `subscription_invoice` sin `tenant_id` — resuelto en el bloque 1.1

Ambas llegaban a la empresa sólo a través de su tabla padre (`role`,
`subscription`), así que una consulta directa veía las de todas las empresas.
`subscription_invoice` además estaba excluida de la RLS a mano.

- Las dos llevan `tenant_id` y RLS: **57 tablas protegidas** (antes 55).
- Claves foráneas **compuestas** `(tenant_id, role_id) → role(tenant_id, id)`:
  la base de datos impide colgar una fila de una empresa del padre de otra,
  incluso al rol dueño, que no está sujeto a RLS.
- `verify_tenant_isolation()` tiene una comprobación nueva: señala toda tabla
  con clave foránea hacia una tabla protegida que **no** tenga `tenant_id`
  propio. Las comprobaciones anteriores sólo veían tablas que ya lo tenían.
- La migración rellena `tenant_id` desde la tabla padre en tres tiempos
  (opcional → UPDATE → NOT NULL), probada sobre una base sembrada con 278
  permisos.

### No se usa `prisma migrate dev` — descubierto en el bloque 1.1

Los índices GIN (texto, trigram, jsonb) y HNSW (vectores) se crean desde
`prisma/sql/02_search_and_indexes.sql` porque `schema.prisma` no puede
declararlos. `prisma migrate dev` compara la base **real** con el historial de
migraciones, los ve como una desviación y **ofrece reiniciar la base de datos**.
No ocurrió antes sólo porque esos índices se aplicaron después de la última
migración.

- **Aplicar migraciones:** `pnpm db:migrate` → `migrate deploy` + scripts SQL.
  Nunca propone reiniciar; es lo mismo que usan el CI y producción.
- **Crear una migración:** `pnpm db:migration:new <nombre>`. Compara el
  **historial** con el esquema sobre una base auxiliar (`<base>_shadow`), así que
  la base real no interviene, y avisa del SQL que falla sobre tablas con datos
  (`ADD COLUMN … NOT NULL`) o que borra datos.

### Autenticación — bloque 1.2a

| Decisión                                                                      | Por qué                                                                                                                                                         |
| ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Correo verificado antes de entrar**                                         | Decidido para un CRM B2B: evita cuentas con correos ajenos                                                                                                      |
| **2FA obligatorio para propietarios, con 7 días de plazo**                    | Seguridad real sin fricción en el primer uso. Vencido el plazo, sólo se puede configurar el 2FA                                                                 |
| **Argon2id nativo de Node**                                                   | Estable en Node 26 (sin marca de estabilidad propia en la documentación de la 26.9). Una dependencia nativa menos en la parte más sensible                      |
| **TOTP implementado en el proyecto**                                          | Algoritmo corto y completamente especificado. `pnpm --filter @nexo/api crypto:selftest` lo valida contra los vectores oficiales de RFC 4226, 6238 y 4648, en CI |
| **Access token de 15 min en memoria + refresh rotativo en cookie `httpOnly`** | El token de acceso no está en ningún almacén que un XSS pueda leer; la cookie sólo viaja a `/api/v1/auth`                                                       |
| **Reuso de refresh = revocar la familia entera**                              | No se puede saber quién tiene la copia legítima: pierden la sesión los dos                                                                                      |
| **CSRF: cabecera `x-nexo-client` + comprobación de `Origin`**                 | En las rutas que actúan con la cookie                                                                                                                           |
| **Respuestas idénticas exista o no la cuenta**                                | Registro, reenvío y recuperación. En el login, además, mismo coste de Argon2 con un hash ficticio                                                               |

**Identidad de usuario sin empresa (`app.user_id`).** Al iniciar sesión todavía no
hay empresa en el contexto, y `membership` tiene RLS por empresa: el usuario no
podría ver ni sus propias empresas. Se resuelve igual que el alta de empresas,
sin privilegios: la API fija `app.user_id` sólo tras verificar las credenciales,
y tres políticas de **sólo lectura** le dejan ver sus membresías, las empresas a
las que pertenece y sus roles. Nada más: los datos de negocio siguen exigiendo
`app.tenant_id`.

**Pendiente para el bloque 1.2b:** la web tiene que serializar la renovación de
la sesión entre pestañas (una sola petición de refresco a la vez). Con la
detección de reuso estricta, dos pestañas renovando a la vez con la misma
cookie cerrarían la sesión.

### El particionado de `message` queda aplazado

El plan lo daba por hecho desde el inicio. Prisma no puede crear una tabla
`PARTITION BY`, y convertirla después exige recrear y copiar.

Decisión: **no particionar ahora.** A escala de arranque los índices compuestos
rinden de sobra, y particionar añade operación —crear las particiones futuras,
vigilar que existan— que todavía no compra nada. El momento es cuando `message`
pase de unos 50 millones de filas o los respaldos empiecen a doler; el
procedimiento queda escrito para no improvisarlo bajo presión.

### La unicidad de contacto tuvo que salir de Prisma

`@@unique([tenantId, email])` prohíbe recrear un contacto que se borró, porque
el borrado es lógico y la fila sigue ahí. La unicidad real es un índice
**parcial** (`WHERE deleted_at IS NULL`) sobre `lower(email)`, que Prisma no
sabe declarar. Vive sólo en `sql/02_search_and_indexes.sql`; el `schema.prisma`
no lleva esos `@@unique` para que ninguna migración los recree y los pise.

### MinIO no sirve para producción

El plan preveía MinIO autoalojado. Al levantar el entorno resultó que MinIO
dejó de publicar las imágenes de su edición comunitaria: `minio/minio` ya no
existe en Docker Hub y en quay.io sólo quedan versiones congeladas, sin
actualizaciones de seguridad públicas.

- **Desarrollo:** se usa la última versión congelada de quay.io, fijada por
  etiqueta. Suficiente para trabajar en local.
- **Producción:** pendiente de decidir entre un servicio compatible con S3
  (Cloudflare R2, AWS S3, Backblaze B2) o SeaweedFS autoalojado. La aplicación
  sólo usa la API S3 estándar, así que es un cambio de configuración.

---

## Alcance decidido

| Punto             | Decisión                                                                                 |
| ----------------- | ---------------------------------------------------------------------------------------- |
| Facturación       | Documentos internos + PDF. La integración fiscal por país queda en el roadmap            |
| Pasarela de pagos | Sin acoplar hasta la Fase 5. `plan` y `subscription` ya existen y sus límites se aplican |
| Escala objetivo   | Arranque pequeño: un VPS, sin réplicas ni servicio gestionado                            |
| Orden de fases    | 0 y 1 completas primero; después WhatsApp (Fase 2)                                       |

---

## Pendiente de ti

|                                          | Bloquea                                                                            |
| ---------------------------------------- | ---------------------------------------------------------------------------------- |
| Nombre y dominio reales del producto     | Nada, pero cambiarlo tarde es caro. Centralizado en `packages/design/src/brand.ts` |
| Cuenta de Meta Business verificada       | Fase 2. **La verificación tarda días o semanas: conviene iniciarla ya**            |
| Clave de OpenAI y techo mensual de gasto | Fase 3                                                                             |
