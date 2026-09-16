# Arquitectura

Versión navegable, con diagramas:
**<https://claude.ai/code/artifact/5700f054-f5b9-4489-87d2-e6be8b4e436a>**

Este documento es el registro *en el repositorio*: las decisiones que gobiernan
el código, y las correcciones que aparecieron al implementarlas.

---

## Decisiones que definen el sistema

| Decisión | Elegido | Descartado y por qué |
|---|---|---|
| Aislamiento | BD compartida + `tenant_id` + RLS forzada | Un esquema por empresa: migrar miles de esquemas es inviable. BD por empresa: coste desproporcionado hasta facturar mucho |
| Repositorio | Monorepo pnpm + Turborepo | Repos separados: los tipos entre API y web se desincronizan |
| Sesión | Cookie `httpOnly` + refresh rotativo | JWT en `localStorage`: cualquier XSS se lleva la sesión entera |
| Búsqueda | `pg_trgm` + `tsvector` nativos | Elasticsearch: un servicio más que operar y sincronizar sin necesidad aún |
| Embeddings | `pgvector` en la misma base | Pinecone/Qdrant: una segunda superficie donde podrían filtrarse datos entre empresas |
| Colas | BullMQ sobre Redis | Cron dentro de la API: no sobrevive a reinicios ni escala sin duplicar ejecuciones |
| Tiempo real | Socket.IO + adaptador Redis | Polling: latencia y coste. SSE: unidireccional, no sirve para acuses ni "escribiendo…" |
| Automatizaciones | Intérprete de grafos propio | n8n/Temporal embebidos: imponen su modelo de datos y su interfaz |
| PDF | React → HTML → Puppeteer | Librerías por coordenadas: cada cambio de plantilla es aritmética a mano |
| Estado cliente | React Query (servidor) + Zustand (UI) | Redux global con datos del servidor: invalidación manual y el triple de código |

---

## Las tres capas de aislamiento

1. **Contexto de petición** — `AsyncLocalStorage` (`packages/database/src/tenant-context.ts`)
2. **Extensión de Prisma** — inyecta `tenantId` en `where` y `data` (`packages/database/src/client.ts`)
3. **Row Level Security** — políticas en Postgres (`packages/database/prisma/sql/01_rls.sql`)

Las dos primeras son de aplicación y dan *corrección*. La tercera da
*seguridad*: no se puede saltar desde el código porque la aplicación conecta
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

| Dominio | Tablas |
|---|---:|
| Plataforma | 7 |
| Identidad y acceso | 9 |
| CRM | 8 |
| Ventas | 7 |
| Conversaciones | 7 |
| Inteligencia artificial | 6 |
| Automatizaciones | 5 |
| Documentos comerciales | 6 |
| Agenda y tareas | 5 |
| Analítica e infraestructura | 6 |
| **Total** | **66** |

De ellas, **55 llevan `tenant_id` obligatorio** y política RLS (el plan decía
41). `tenant` tiene política propia contra su clave primaria, y 10 quedan fuera
por motivos escritos en `_rls_excluded_tables()`.

### Con RLS forzada, nadie podía crear una empresa

Una política única `FOR ALL` sobre `tenant` cuyo `WITH CHECK` exigiera
`id = current_tenant_id()` hace el registro **imposible**: al darse de alta
todavía no existe la empresa cuyo contexto habría que fijar. El seed tampoco
podía arrancar.

Corregido separando el `INSERT` del resto: crear una empresa se permite
siempre, y `SELECT` / `UPDATE` / `DELETE` siguen restringidos a la fila propia.
Cualquiera puede registrarse; nadie puede leer ni tocar la empresa de otro.

### …y la corrección anterior no basta: pendiente para la Fase 1

Separar el `INSERT` de `tenant` no es suficiente. Prisma crea filas con
`INSERT ... RETURNING`, y Postgres exige que la fila **devuelta** pase la
política de **lectura**, que sólo deja ver la empresa del contexto activo. Al
registrarse no hay contexto, así que el `INSERT` se rechazaría igual.

Lo mismo le ocurre al panel de plataforma: listar todas las empresas es, por
definición, leer sin contexto de empresa.

- **Seed y migraciones:** resuelto. Conectan con el rol dueño, que en
  desarrollo es superusuario y no está sujeto a RLS.
- **Registro y panel de plataforma:** a resolver en la Fase 1 con una vía
  privilegiada y acotada — un rol `nexo_platform` usado sólo por esos dos
  módulos, o funciones `SECURITY DEFINER` para las operaciones concretas — en
  lugar de relajar la política de `tenant` para todo el mundo.

### `role_permission` no lleva `tenant_id`: pendiente para la Fase 1

Llega a la empresa sólo a través de `role`, que sí tiene RLS. Una consulta
directa a `role_permission` vería la configuración de permisos de todas las
empresas. El dato es poco sensible, pero rompe la regla de aislamiento por
construcción, y `verify_tenant_isolation()` no puede detectarlo porque sólo
inspecciona tablas que **tienen** `tenant_id`.

Corrección prevista al empezar la Fase 1: añadir `tenantId` a `RolePermission`
(queda cubierta automáticamente por RLS) y ampliar la verificación para que
señale toda tabla con clave foránea hacia una tabla protegida que no tenga
política propia.

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

| Punto | Decisión |
|---|---|
| Facturación | Documentos internos + PDF. La integración fiscal por país queda en el roadmap |
| Pasarela de pagos | Sin acoplar hasta la Fase 5. `plan` y `subscription` ya existen y sus límites se aplican |
| Escala objetivo | Arranque pequeño: un VPS, sin réplicas ni servicio gestionado |
| Orden de fases | 0 y 1 completas primero; después WhatsApp (Fase 2) |

---

## Pendiente de ti

| | Bloquea |
|---|---|
| Nombre y dominio reales del producto | Nada, pero cambiarlo tarde es caro. Centralizado en `packages/design/src/brand.ts` |
| Cuenta de Meta Business verificada | Fase 2. **La verificación tarda días o semanas: conviene iniciarla ya** |
| Clave de OpenAI y techo mensual de gasto | Fase 3 |
