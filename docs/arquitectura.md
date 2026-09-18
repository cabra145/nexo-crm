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

### Autenticación en la web — bloque 1.2b

| Decisión                                                   | Por qué                                                                                                                                                                                  |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Renovación serializada entre pestañas**                  | Web Locks (`nexo:session-refresh`): una pestaña renueva a la vez; BroadcastChannel reparte la sesión nueva. Sin esto, la detección de reuso cerraría la sesión con dos pestañas abiertas |
| **La puerta de `/w/[empresa]` se decide en el navegador**  | La cookie de refresco es del dominio de la API y el servidor de la web no la ve. La protección real sigue en la API: sin token no hay datos                                              |
| **Tokens de un solo uso fuera de la URL**                  | Verificación y recuperación leen el token y lo quitan con `history.replaceState`; además `Referrer-Policy: no-referrer` en esas páginas                                                  |
| **`next` sólo acepta rutas propias**                       | `safeNext` descarta URLs absolutas y `//dominio`: sin redirección abierta tras el login                                                                                                  |
| **Pruebas de navegador con Playwright contra la API real** | Registro con el enlace de Mailpit, 2FA con TOTP calculado en la prueba, códigos de recuperación, recuperación de contraseña y tres pestañas recargando a la vez                          |

**Margen de reintento del token de refresco (20 s).** Las pruebas de navegador
lo destaparon: una recarga puede cortar una renovación DESPUÉS de que la API la
procese. La cookie nueva no llega, el navegador presenta la anterior y la
detección de reuso cerraba la sesión de un usuario legítimo; lo mismo pasa con
un corte de red. Ahora un token ya canjeado se acepta de nuevo sólo si: se
canjeó hace menos de 20 s, llega con el mismo User-Agent, ningún token posterior
de la familia se ha usado ni revocado, y hay menos de 3 sin usar. Si falla
cualquiera, es reuso y cae la familia. Es el compromiso del «reuse interval» de
Auth0 y el «grace period» de Okta; `auth:e2e` cubre el reintento y los tres
robos (cadena avanzada, otro navegador, fuera de plazo) y el tope.

**Auditoría idempotente sin errores.** Un reintento del mismo evento de
auditoría chocaba con `audit_log_pkey` y el worker capturaba el P2002, pero
Prisma ya había escrito `Unique constraint failed` en el log. Ahora es
`INSERT … ON CONFLICT (id) DO NOTHING` (`createMany` con `skipDuplicates`): cero
filas = ya registrada. El CI falla si el log del worker contiene `prisma:error`.

`localhost`, no `127.0.0.1`, en `APP_URL` y `NEXT_PUBLIC_API_URL`: web y API
tienen que ser el mismo _sitio_ para que el navegador envíe la cookie
`SameSite=Lax`.

### Equipo, roles y permisos — bloque 1.3

| Decisión                                                     | Por qué                                                                                                                                                                                                           |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Permisos en vivo, no del token**                           | El token dura 15 min. Un guard global lee rol y estado de la membresía en cada petición (caché en Redis por empresa y generación): desactivar, dar de baja o cambiar un rol surte efecto en la siguiente petición |
| **Invalidación por generación de empresa**                   | Cualquier cambio de miembros o roles incrementa un contador por empresa y todas sus entradas de caché dejan de usarse; no hay que saber a quién afecta un cambio de rol. Sin Redis, se lee de la base             |
| **Anti-escalada con `canGrant`**                             | Sólo se asigna, crea, edita o toca un rol cuyos permisos estén todos dentro de los propios, con igual o menor alcance. La regla vive en `@nexo/contracts`: la web la usa para no ofrecer lo que la API rechazaría |
| **Propietario único y protegido**                            | No se invita, asigna, degrada, desactiva ni da de baja por la gestión de miembros. Sólo cambia con la transferencia, que pide contraseña + código del propietario y que el nuevo tenga 2FA                        |
| **Invitan Propietario y Administrador**                      | `member:invite`; los responsables no invitan                                                                                                                                                                      |
| **Plazas del plan**                                          | Activos + invitaciones pendientes (los desactivados no cuentan). Se comprueban con `pg_advisory_xact_lock` por empresa: `rbac:e2e` lanza 12 invitaciones simultáneas con 2 plazas libres y exige exactamente 2    |
| **Roles personalizados según plan**                          | `plan_feature.custom_roles` (Pro, Business). El alcance sólo se guarda en permisos sobre datos con dueño; en el resto se normaliza a toda la empresa                                                              |
| **Invitación = membresía `INVITED` + enlace de un solo uso** | Sin tabla nueva: `email_token` con la empresa y la membresía en `payload`, índice parcial para buscarlas. Reenviar invalida el enlace anterior; cancelar, también                                                 |

**Aceptar una invitación, tres caminos.** Cuenta nueva: elige nombre y
contraseña en `/invitacion` y entra (el enlace verifica el correo). Sesión
abierta de la cuenta invitada: un botón. Cuenta existente sin sesión: inicia
sesión con el token de la invitación, que se canjea al completar el login
(también con 2FA). Así funciona aunque no pertenezca a ninguna otra empresa, en
cuyo caso no podría iniciar sesión para aceptarla después. Con una cuenta
existente, el enlace solo no basta: hace falta su contraseña.

**Quien pierde una empresa no pierde la sesión.** Al renovar, si la empresa de
la sesión ya no está disponible, se continúa en otra suya; el cambio explícito
de empresa sí falla. La web no repite la petición rechazada con el token nuevo:
iría contra otra empresa.

**Pruebas que se han visto fallar.** Con la anti-escalada, la invalidación de
caché o el bloqueo de plazas desactivados a propósito, `rbac:e2e` falla en las
comprobaciones correspondientes (con 4 invitaciones simultáneas la carrera no
se reproducía; con 12, sí).

### CRM: contactos y empresas — bloque 1.4a

| Decisión                                                               | Por qué                                                                                                                                                                                                                                                                                                                 |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **El alcance se resuelve en el servicio, no en el controlador**        | `AccessService.rowFilter(access, permiso)` devuelve el fragmento de `where` que corresponde al rol: nada (empresa), su equipo o sólo los suyos. Se aplica en listar, buscar, ver, editar y borrar; fuera de alcance se responde 404, no 403, porque «existe pero no es tuyo» ya es información                          |
| **Los registros sin responsable sólo los ve quien ve todo**            | Un agente no debe encontrarse contactos que nadie le asignó. El filtro «sin responsable» existe para quien reparte el trabajo                                                                                                                                                                                           |
| **Equipo vacío = sólo lo suyo**                                        | Un responsable sin equipo asignado no ve toda la empresa; lo contrario abriría datos por un campo en blanco                                                                                                                                                                                                             |
| **Unicidad de correo y teléfono en la base, no en el código**          | Índices únicos parciales por empresa que ignoran los borrados. Dos altas simultáneas del mismo correo no pueden colarse, y borrar un contacto libera su correo                                                                                                                                                          |
| **El conflicto se explica con nombre y enlace**                        | El 409 lleva `resourceId` del contacto que ya tiene ese correo, y la web ofrece abrirlo. La consulta va FUERA de la transacción: tras un choque de restricción, Postgres la aborta (era un 500 disfrazado de conflicto)                                                                                                 |
| **Búsqueda: texto completo + trigram sin acentos**                     | El tsvector en español encuentra palabras completas («perez» → «Pérez»); el trigram sobre `nexo_unaccent(full_name)` encuentra trozos («erez») y los últimos dígitos de un teléfono, que es como la gente busca. `unaccent` no es IMMUTABLE, así que se indexa a través de un envoltorio propio que fija el diccionario |
| **Borrado lógico**                                                     | Nada se pierde por un clic. Al eliminar una empresa, sus contactos NO se borran: se desvinculan conservando el nombre como texto                                                                                                                                                                                        |
| **Cuota de contactos con bloqueo por empresa**                         | Igual que las plazas de usuarios: `crm:e2e` lanza 8 altas simultáneas con 2 huecos y exige que entren exactamente 2                                                                                                                                                                                                     |
| **El consumo del plan sólo se muestra a quien ve todos los contactos** | A un agente, «3 de 5000» le diría de más y le explicaría de menos                                                                                                                                                                                                                                                       |

**Pruebas que se han visto fallar.** Con el filtro de alcance desactivado a
propósito, `crm:e2e` falla en cuatro comprobaciones: el agente veía los cuatro
contactos de la empresa, abría y editaba fichas ajenas, el responsable veía
otros equipos y la búsqueda devolvía de más.

### Agenda: tareas, notas e historia — bloque 1.4b

| Decisión                                                           | Por qué                                                                                                                                                                                              |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **El alcance de las tareas va sobre `assigneeId`**                 | Mismo mecanismo que los contactos, otro campo: un agente ve las suyas, un responsable las de su equipo. Una tarea sin responsable sólo la ve quien tiene alcance de empresa                          |
| **«Hoy» se calcula con la zona del navegador**                     | El navegador manda su desfase (`getTimezoneOffset`) y los tramos se calculan con él. Con el servidor en UTC y el usuario en Quito, una tarea de las 23:00 locales no puede aparecer como «de mañana» |
| **La fecha de cierre la pone el servidor**                         | Completar una tarea guarda `completedAt` en la API, no en el cliente; reabrirla lo borra                                                                                                             |
| **Una tarea sólo se vincula a un contacto que puedas ver**         | Si no, sería una vía para descubrir contactos ajenos por su id                                                                                                                                       |
| **Las notas las edita su autor, y nadie más salvo administración** | `contact:delete` con alcance de EMPRESA puede corregirlas; un responsable de equipo las lee pero no las reescribe. Lo que alguien anotó es su testimonio de lo que pasó                              |
| **Tres secciones, no una lista mezclada**                          | Tareas (trabajo por hacer), notas (lo que alguien quiso dejar escrito) e historia (registro de lo ocurrido). Mezclarlas obliga a leerlo todo para encontrar cualquiera de las tres                   |
| **La casilla de completar responde al instante**                   | Actualización optimista con reversión si la API falla. Se vio en la prueba: esperar la ida y vuelta hacía que la casilla no reaccionara al primer clic                                               |

**Diagnóstico antes que reintento.** Un fallo intermitente de `auth:e2e` acabó
en un `TypeError` sobre un campo ausente, que escondía la causa real (no llegó
el correo). Ahora, si el enlace no aparece, la prueba corta con un mensaje que
dice dónde mirar: el log del worker y la cola `email`.

**Margen para máquinas cargadas.** Una ejecución completa pasó de 40 s a 8 min
con el mismo código, y nueve pruebas de navegador fallaron por clics sobre
elementos que aún se movían; la causa era la carga de la máquina (un `pnpm dev`
y Docker a la vez), no el producto. Playwright tiene ahora un reintento y
tiempos más holgados: un fallo real vuelve a fallar en el reintento, la
lentitud no.

### Embudo de ventas y tablero Kanban — bloque 1.5

| Decisión                                                              | Por qué                                                                                                                                                                                                         |
| --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **La posición la calcula el servidor**                                | El cliente manda entre qué dos tarjetas suelta, nunca un número. El servidor toma el punto medio con la columna bloqueada, así que dos personas moviendo a la vez no escriben órdenes incompatibles             |
| **Mover escribe una sola fila; reequilibrar, sólo cuando hace falta** | Cuando el hueco entre dos vecinas baja de 0,0001, se renumera la columna entera con `rebalance_stage_positions` y se recalcula. `deals:e2e` parte el mismo hueco 60 veces y exige orden correcto y cero empates |
| **Arrastrar a «Ganado» o «Perdido» cierra la oportunidad**            | Y devolverla a una etapa abierta la reabre y borra el motivo. Es lo que espera quien arrastra, sin obligarle a cambiar además un estado aparte                                                                  |
| **Historial de etapas desde el primer día**                           | Cada cambio de etapa cierra el tramo anterior con su duración. Sin eso, «cuánto tarda una oportunidad en negociación» no se puede reconstruir después                                                           |
| **El tablero se mueve al instante**                                   | Actualización optimista con reversión si la API lo rechaza (por ejemplo, si otra persona movió la vecina mientras arrastrabas: 409)                                                                             |
| **Arrastrar no es la única forma**                                    | Cada tarjeta tiene un selector «Mover a…», que funciona con teclado, lector de pantalla y pantalla táctil                                                                                                       |
| **Alcance por rol sobre `ownerId`**                                   | Tarjetas y totales de columna salen ya filtrados: un agente no ve cuánto vale el embudo de los demás                                                                                                            |

**Una prueba que no probaba lo que decía.** La primera versión de `deals:e2e`
movía la misma tarjeta una y otra vez entre las mismas dos vecinas y daba por
bueno el reequilibrio. Pero ese punto medio no cambia nunca: el hueco no se
agotaba y el reequilibrio no llegaba a ejecutarse (separación mínima final de
500). Ahora la prueba alterna dos tarjetas detrás de la misma vecina, comprueba
que el hueco bajó de verdad (6·10⁻⁵) y, con el reequilibrio desactivado a
propósito, falla: orden roto y dos posiciones empatadas.

**El Mac dormido.** Una ejecución falló porque el equipo entró en reposo a
mitad de la prueba (visto en `pmset -g log`: 21:09:37 → 21:15:45, los mismos
375 s que faltaban en el registro de la API). Dos arreglos: `ci-local` mantiene
el equipo despierto con `caffeinate`, y las pruebas ya no comparan la hora de
Mailpit (en la máquina virtual de Docker) con la del sistema. Un correo nuevo
es uno aún no leído, no uno con hora posterior.

**Pendiente, a propósito:** la configuración de embudos y etapas desde la
interfaz (`pipeline:manage`) y la sección de oportunidades en la ficha del
contacto llegan con los paneles comerciales. Hoy el contacto ya guarda en su
historia la creación de sus oportunidades y cada cambio de etapa.

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
