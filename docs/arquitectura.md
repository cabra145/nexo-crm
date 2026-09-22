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

### WhatsApp: canal y webhook — bloque 2.1

| Decisión                                                | Por qué                                                                                                                                                                                                                                                             |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Conexión manual, con la app de Meta de cada empresa** | La empresa pega el identificador del número, el de su cuenta, un token de usuario del sistema y la clave secreta de su app. El registro integrado de Meta («Embedded Signup») exige ser proveedor tecnológico verificado; podrá venir después sobre esta misma base |
| **Se comprueba con Meta antes de guardar**              | Conectar consulta el número en la Graph API con ese token. Un canal que parece conectado pero no recibe nada es peor que un error al darlo de alta                                                                                                                  |
| **Una URL de webhook por canal**                        | `/api/v1/webhooks/whatsapp/{id del canal}`. Cada empresa firma con la clave de SU app, así que la URL dice qué clave usar; además el `phone_number_id` del evento tiene que ser el del canal, o se ignora                                                           |
| **La empresa del webhook se averigua sin privilegios**  | Identidad de sólo lectura `app.webhook_channel_id` (01_rls.sql, 3c): con el id de la URL se puede leer ESA fila de `channel` y nada más. Mismo patrón que la identidad de usuario del inicio de sesión; ninguna función SECURITY DEFINER                            |
| **Firma HMAC sobre los bytes exactos**                  | `X-Hub-Signature-256` se calcula sobre el cuerpo crudo (`rawBody`), comparado en tiempo constante. Volver a serializar el JSON cambiaría los bytes                                                                                                                  |
| **Recibir y procesar, separados**                       | La API sólo verifica, guarda en `webhook_event` y encola; responde a Meta al momento. El worker crea contacto, conversación y mensaje en UNA transacción de la empresa, con reintentos                                                                              |
| **Idempotencia en dos capas**                           | El mismo cuerpo no se guarda dos veces (su SHA-256 es el id del evento), y el mismo mensaje no se guarda dos veces (índice único canal + `wamid`), aunque llegue en otro cuerpo                                                                                     |
| **Los estados de entrega sólo avanzan**                 | Meta no garantiza el orden: un «entregado» tras un «leído» se ignora, y un «fallido» no deshace uno ya entregado o leído                                                                                                                                            |
| **El contacto se reconoce por su número**               | Como WhatsApp o como teléfono; si no existe se crea sin responsable, con un bloqueo por número para que dos mensajes simultáneos de alguien nuevo no creen dos contactos                                                                                            |
| **Credenciales cifradas, nunca devueltas**              | Token y clave secreta van con AES-256-GCM. La interfaz sólo muestra lo que hay que pegar en Meta: la URL y el token de verificación                                                                                                                                 |
| **Desconectar conserva el historial**                   | Borra las credenciales y libera el número para conectarlo en otra empresa; las conversaciones se quedan                                                                                                                                                             |
| **Un simulador de Meta en las pruebas**                 | `whatsapp:e2e` levanta una Graph API falsa y firma los eventos como Meta. El CI no depende de Meta ni de un número real; la validación contra Meta de verdad queda para el bloque 2.4                                                                               |

**Pruebas que se han visto fallar.** Con la firma sin comprobar, un evento
firmado con otra clave entraba. Sin comprobar el número del canal, el mensaje
de la empresa B aparecía en la empresa A. Con los estados sin orden, un
«fallido» deshacía un mensaje leído. Con la política del webhook abierta, la
prueba de aislamiento veía los dos canales. Y un fallo de la propia prueba: dos
avisos de estado en el mismo segundo tenían el mismo cuerpo, el segundo se
descartaba como reenvío y la comprobación del orden pasaba sin probar nada;
ahora cada aviso lleva su instante.

**El límite de inicio de sesión por IP y el CI.** Todas las suites entran
desde 127.0.0.1; sumadas hacían 52 inicios de sesión, por encima de los 50 cada
15 minutos que se permiten a una IP, y la última prueba de navegador recibía
429 («Demasiados intentos»). El límite es correcto; el fallo era que una suite
heredaba el contador de otra. Antes de Playwright,
`scripts/reset-login-ip-limits.ts` borra sólo los contadores `login-ip`; los
bloqueos por cuenta no se tocan.

**Por confirmar contra Meta real (2.4):** la versión de la Graph API
(`META_GRAPH_VERSION`, hoy `v21.0` por defecto) y los textos exactos de sus
errores.

### Bandeja de entrada y tiempo real — bloque 2.2

| Decisión                                                                  | Por qué                                                                                                                                                                                                                                                               |
| ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Las nuevas llegan sin asignar y cualquiera las toma**                   | Una conversación sin asignar la ve todo el que puede ver conversaciones, sea cual sea su alcance; asignada, la ven quien la lleva y quien tiene alcance sobre esa persona. Responder a una sin asignar la toma: dos agentes no contestan al mismo cliente sin saberlo |
| **Tomar es un UPDATE condicional**                                        | `WHERE assignee_id IS NULL` en la propia escritura: si dos la toman a la vez, una recibe 409. Sin bloqueos largos ni comprobar-y-luego-escribir                                                                                                                       |
| **Asignar exige alcance sobre las dos personas**                          | Sobre quien la tenía y sobre quien la recibe, y el destinatario tiene que poder ver conversaciones                                                                                                                                                                    |
| **Enviar no espera a Meta**                                               | La API guarda el mensaje en QUEUED y lo encola (`whatsapp-outbound`); el worker llama a Meta FUERA de cualquier transacción. Red, 5xx y límites de tasa se reintentan; un rechazo definitivo queda FAILED con el motivo de Meta y el agente puede reintentarlo        |
| **La ventana de 24 h se comprueba en la API y se muestra en la interfaz** | Fuera de ella, 409 y nada llega a Meta; la pantalla lo dice antes de que el agente escriba                                                                                                                                                                            |
| **SSE, no WebSocket**                                                     | Los avisos van en un solo sentido; SSE es HTTP normal (pasa por Nginx y balanceadores sin configuración especial)                                                                                                                                                     |
| **Un aviso no lleva datos**                                               | Sólo «esta conversación cambió» y a quién está asignada. La web vuelve a pedirla por la API con sus permisos: el canal de avisos no puede filtrar nada, y no hay dos fuentes de verdad                                                                                |
| **Avisos por Redis pub/sub**                                              | La API y el worker publican en el canal de la empresa; cada proceso de la API reparte a SUS conexiones. Funciona igual con una instancia que con varias                                                                                                               |
| **Permisos en vivo en cada aviso**                                        | Antes de entregar un aviso se resuelve el acceso con la caché de siempre: a quien desactivan se le cierra la conexión en el siguiente aviso. Y la conexión se cierra al caducar el token; la web reconecta con el renovado                                            |
| **`fetch` con streaming, no `EventSource`**                               | `EventSource` no permite la cabecera `Authorization`, y el token en la URL acabaría en logs                                                                                                                                                                           |
| **Al (re)conectar se recarga todo**                                       | Lo que ocurriera durante un corte se recupera sin reproducir avisos perdidos                                                                                                                                                                                          |

**El estado que llega antes que el mensaje.** Meta puede avisar de
«entregado» antes de que el worker haya guardado el id que Meta le devolvió al
enviar. Si ese aviso se ignorara, el mensaje se quedaría en «enviado» para
siempre. Si llega el estado de un id desconocido, es reciente y hay un envío en
curso en ese canal, el evento se reintenta con la espera de la cola. La prueba
lo reproduce: el simulador retiene la respuesta del envío mientras envía el
estado.

**Idempotencia del envío.** Sólo se envía un mensaje en QUEUED, y el resultado
se escribe con la condición «sigue en QUEUED». Queda una ventana inevitable
(Meta acepta y el worker cae antes de guardarlo) en la que el reintento lo
enviaría dos veces: Meta no ofrece clave de idempotencia.

**Pruebas que se han visto fallar.** Sin la condición al tomar, dos agentes la
tomaban a la vez (200 y 200). Con el reparto de avisos sin comprobar
visibilidad, quien había perdido la conversación seguía recibiendo sus avisos,
y quien era desactivado conservaba la conexión. Sin la espera del estado
adelantado, el mensaje terminaba en SENT en vez de DELIVERED.

**Una prueba intermitente del bloque 1.4, corregida.** «Crear, buscar y editar
un contacto» fallaba a veces: la ficha se actualiza un instante antes de que el
diálogo de edición se cierre, y «Cliente» coincidía también con la opción del
selector del diálogo. La prueba ahora espera al cierre del diálogo.

### Almacenamiento de archivos — bloque 2.3a

Cloudflare R2 por defecto, sin depender de él: `@nexo/storage` define la
interfaz `ObjectStorage` y una única implementación sobre la API S3. El
proveedor (`STORAGE_PROVIDER` = `r2`, `s3` o `minio`) sólo cambia los valores
por defecto —endpoint, región, estilo de ruta—; la lógica de negocio no lo
conoce. Pasar a S3 o a MinIO es cambiar variables de entorno.

| Decisión                                                            | Por qué                                                                                                                                                                     |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Una implementación S3, no una por proveedor**                     | Los tres hablan la misma API. Ramas por proveedor serían código que divergiría sin que nadie lo probara                                                                     |
| **Claves `tenants/{empresa}/{propósito}/{año}/{mes}/{uuid}.{ext}`** | Todo lo de una empresa bajo un prefijo (borrar, exportar, medir, reglas de ciclo de vida). El nombre original nunca entra en la clave; `assertTenantKey` es la última red   |
| **Tipo real por número mágico**                                     | Lo que declara quien sube no se cree: un HTML renombrado a «.jpg» no pasa por imagen                                                                                        |
| **Configuración validada al arrancar**                              | En producción, sin credenciales, sin `https` o sin acceso al bucket, la API y el worker no arrancan. El CI lo prueba con una clave equivocada                               |
| **`https` salvo hacia la propia máquina**                           | El CI prueba en modo producción contra un MinIO local; los navegadores tratan `localhost` como contexto seguro. `localhost.atacante.com` no cuenta                          |
| **El almacenamiento se informa en `/health/ready`, pero no decide** | Si R2 cae sólo fallan los archivos; sacar la API del balanceador cortaría también el chat y el inicio de sesión. La sonda es pública: da el motivo, no el nombre del bucket |
| **Sumas CRC del SDK sólo cuando se exigen**                         | Las que el SDK de AWS añade por defecto desde 2025 no las admiten todos los compatibles con S3 en URLs firmadas                                                             |
| **El bucket de producción se crea a mano**                          | `ensure-bucket` sólo actúa sobre MinIO: crear buckets exigiría dar a la aplicación permisos de administración                                                               |
| **MinIO en el CI como paso, no como servicio**                      | Los servicios de GitHub Actions no admiten el comando del contenedor (`server /data`)                                                                                       |

**Ciclo de vida de un archivo.** `file.status`: PENDING (reservado, a la
espera del contenido) → READY (tipo real y tamaño comprobados) o REJECTED.
Sólo un READY se firma para descarga o se envía. Los PENDING antiguos son
subidas abandonadas, y la limpieza periódica los borra; por eso la migración
pasa a READY los archivos que ya existían.

**Política de archivos** (`contracts/files.ts`), una sola para la web, la
API y el worker. Los tipos son los que acepta WhatsApp Cloud API; cualquier
otro se rechaza, y el tipo que se comprueba es siempre el DETECTADO.

| Categoría | Tipos                               | Máximo |
| --------- | ----------------------------------- | ------ |
| Imagen    | JPEG, PNG                           | 5 MB   |
| Sticker   | WebP                                | 500 KB |
| Audio     | AAC, AMR, MP3, M4A, Ogg (Opus)      | 16 MB  |
| Vídeo     | MP4, 3GP                            | 16 MB  |
| Documento | PDF, texto, Word, Excel, PowerPoint | 25 MB  |

- **Documentos hasta 25 MB, no los 100 de Meta**: en este bloque el worker
  procesa cada archivo en memoria. Subirlo exige subida por partes y en flujo.
- **Sólo imágenes, stickers, audio y vídeo se muestran en el navegador.** Los
  PDF se descargan siempre (pueden llevar JavaScript, y no deben abrirse desde
  el dominio del almacenamiento), igual que texto, Office y cualquier tipo
  desconocido. SVG, HTML y GIF no se admiten nunca.
- **La extensión de la clave sale del tipo detectado**, nunca del nombre.
- **Ogg sólo con Opus**, como exige Meta; el códec no se comprueba: si Meta lo
  rechaza, el mensaje queda fallido con su motivo.
- La autoprueba comprueba que cada tipo admitido lo reconoce el detector de
  @nexo/storage y al revés: admitir en la política un tipo que el detector no
  produce, o servir los PDF en línea, la hace fallar (probado).

**Archivos que envían los clientes** (cola `whatsapp-media`). El procesador de
entrada crea una fila `message_media` por archivo en la misma transacción que
el mensaje y encola su descarga ANTES de dar el evento por procesado: si
encolar falla, el evento se reintenta, sus mensajes salen como repetidos y sus
archivos pendientes se vuelven a encolar (id del trabajo = id de la fila). El
trabajo, en el contexto de su empresa:

1. Pide los datos del archivo a Meta **con el `phone_number_id` del canal**:
   Meta sólo lo entrega si es de ese número, así que el id de un archivo de
   otra empresa no sirve de nada.
2. Rechaza por el tamaño declarado **sin descargar**.
3. Descarga **sólo de `META_MEDIA_HOSTS`** (por defecto `lookaside.fbsbx.com`),
   por https salvo hacia la propia máquina y **sin seguir redirecciones**: la
   petición lleva el token de la empresa, y otro dominio se lo quedaría (SSRF).
   Un contador de bytes corta la descarga al pasar el límite, declare Meta lo
   que declare.
4. Exige el **SHA-256** de Meta y un **tipo real** (número mágico) admitido y de
   la MISMA categoría que el declarado: un PDF anunciado como imagen se
   rechaza aunque los PDF se admitan.
5. Sube a una clave de la empresa del contexto y crea el `File` READY y el
   enlace en una transacción, con la condición «aún sin archivo»: si otro
   intento se adelantó, se deshace y se borra el objeto duplicado.

Nada se sube antes de pasar las comprobaciones, y si algo falla después de
subir, el objeto se borra. Los rechazos (y el último intento de un fallo
temporal) quedan en `download_error`. La prueba `media:e2e` termina comparando
el bucket con la base: cada objeto es un archivo READY y al revés. Quitar el
SHA-256, el tipo real, la lista de dominios, la condición del enlace o el
`phone_number_id` hace fallar sus comprobaciones (probado, las cinco a la vez).

**Adjuntos que envía el agente** (`POST /conversations/:id/uploads` y el
`fileId` en el envío). Tres fases: reservar, subir directo al almacenamiento y
enviar. La API nunca recibe los bytes.

| Decisión                                       | Por qué                                                                                                                                                                                                                                                                      |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Subida directa con URL firmada**             | La API no mueve archivos de 25 MB. Tipo y tamaño van DENTRO de la firma: subir otra cosa lo rechaza el almacenamiento (403)                                                                                                                                                  |
| **Lo declarado no decide nada**                | Al enviar, la API consulta el objeto ya subido: tamaño real, tipo real por número mágico y **la misma categoría que se declaró** (un HTML subido como «imagen» es texto: un tipo admitido, pero no una imagen). Si no cuadra, el archivo queda REJECTED y el objeto se borra |
| **Un archivo, un mensaje**                     | El paso a READY es condicional; reenviar el mismo `fileId` da 409                                                                                                                                                                                                            |
| **Sólo quien reservó puede adjuntar**          | `file` no cuelga de ninguna conversación, así que se exige el mismo usuario; la conversación de destino ya exige permiso de escritura                                                                                                                                        |
| **Máximo 10 reservas pendientes por persona**  | Una reserva es una fila y un permiso de escritura. La undécima devuelve 429; las abandonadas las recoge la limpieza                                                                                                                                                          |
| **Sin stickers al enviar**                     | Meta exige un WebP muy concreto y rechazaría casi cualquier imagen                                                                                                                                                                                                           |
| **Pie de foto sólo donde WhatsApp lo muestra** | Con audio se responde 400 (sin descartar el archivo, que se puede reenviar sin texto) en lugar de guardar un texto que el cliente no vería                                                                                                                                   |
| **El id de Meta se guarda tras subirlo**       | Un reintento del envío no vuelve a subir los bytes: Meta conserva el archivo 30 días                                                                                                                                                                                         |

Quitar la comprobación del objeto, la condición de «un archivo, un mensaje»,
la comparación de categoría o el tamaño firmado hace fallar sus comprobaciones
(probado, las cuatro a la vez).

**Descargas privadas con URL firmada** (`GET /conversations/:id/media/:mediaId/url`).
Los bytes NO pasan por la API: el navegador los pide al almacenamiento con una
URL firmada de 5 minutos (`STORAGE_URL_TTL_SECONDS`), y la respuesta dice
cuándo caduca para volver a pedirla.

- **Autorización, la de la conversación.** Mismo filtro de visibilidad que la
  bandeja; quien no la ve recibe 404, no 403. El archivo tiene que ser de ESA
  conversación, el `File` estar READY y no borrado, y su clave pasar
  `assertTenantKey`: cuatro capas sobre la RLS y la clave foránea compuesta.
- **Lo que decide el servidor va DENTRO de la firma**: el tipo, si se muestra o
  se descarga (según la política del paso 3) y el nombre. Un cliente no puede
  pedir que un PDF se abra en el navegador; cambiar cualquier parámetro de la
  URL la invalida (403).
- **Los mensajes traen el estado del archivo** (`ready`, `pending`, `failed` con
  su motivo), nunca la clave ni una URL.
- **Sin auditoría por cada imagen vista**: una conversación con veinte fotos
  generaría veinte entradas cada vez que se abre. La auditoría queda para
  descargas de documentos comerciales, exportaciones y acciones sensibles.
- Quitar el filtro de visibilidad, dejar que el cliente elija la entrega o no
  exigir READY hace fallar sus comprobaciones (probado).

**Un agujero entre empresas, cerrado.** `message_media` apuntaba a `message` y
a `file` con claves foráneas simples, que Postgres comprueba SIN RLS: un
adjunto de una empresa podía enlazarse al archivo (o al mensaje) de otra
conociendo su id. Ahora son compuestas `(tenant_id, id)`, como
`role_permission`. La prueba de aislamiento lo intenta en los dos sentidos y
sólo acepta como rechazo el error de esa clave concreta; con las claves
simples de antes, las dos comprobaciones fallan. La FK a `file` es NO ACTION y
no SET NULL, porque con la clave compuesta SET NULL vaciaría también
`tenant_id`.

**Dos correcciones de este paso.** La regla `storage/` de `.gitignore`, de la
plantilla inicial, ignoraba también `packages/storage`: ahora sólo aplica en
la raíz. Y la autoprueba del texto UTF-8 construía bytes que no eran UTF-8
(un byte por carácter); el detector hacía bien en rechazarlos.

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
