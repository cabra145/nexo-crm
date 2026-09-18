# Nexo CRM

Plataforma CRM multiempresa. Cada empresa que se registra obtiene un espacio de
trabajo aislado con sus clientes, sus embudos, su número de WhatsApp, sus
documentos de IA y su facturación.

> **Nombre provisional.** `Nexo` es un nombre de trabajo. Está centralizado en
> [`packages/design/src/brand.ts`](packages/design/src/brand.ts) para que
> cambiarlo sea editar un archivo y no buscar por todo el repositorio.

---

## Estado

| Fase  | Contenido                                                                              | Estado                                                      |
| ----- | -------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| **0** | Monorepo, esquema de datos, RLS, contratos, infraestructura de desarrollo, ESLint y CI | **Terminada**                                               |
| 1     | Auth con 2FA, multi-tenant, RBAC, contactos, empresas, embudo Kanban, tareas           | **En curso** · 1.1, 1.2a, 1.2b, 1.3, 1.4a y 1.4b terminados |
| 2     | WhatsApp Business Cloud API                                                            | Pendiente                                                   |
| 3     | IA con RAG por empresa                                                                 | Pendiente                                                   |
| 4     | Motor de automatizaciones visual                                                       | Pendiente                                                   |
| 5     | Documentos comerciales y suscripciones                                                 | Pendiente                                                   |
| 6     | Calendario, dashboards, panel de plataforma                                            | Pendiente                                                   |
| 7     | Endurecimiento y puesta en producción                                                  | Pendiente                                                   |

La arquitectura completa —incluidas las decisiones descartadas y por qué— está
en [`docs/arquitectura.md`](docs/arquitectura.md).

---

## Requisitos

|            | Versión | Por qué esa                                                                                                       |
| ---------- | ------- | ----------------------------------------------------------------------------------------------------------------- |
| **Node**   | ≥ 24    | `AsyncLocalStorage` estable (base del contexto de empresa) y `process.loadEnvFile` nativo. Verificado con Node 26 |
| **pnpm**   | ≥ 12    | Workspaces, `allowBuilds` y la espera mínima tras publicación que protege de versiones comprometidas              |
| **Docker** | ≥ 24    | Postgres con pgvector, Redis, MinIO y el capturador de correo                                                     |

En macOS:

```bash
brew install node pnpm && brew install --cask docker
```

---

## Puesta en marcha

### 1 · Configuración

```bash
bash infra/scripts/init-env.sh
```

Crea `.env` a partir de `.env.example` con todos los secretos y contraseñas
generados al azar, cada uno distinto, y con permisos 600. Nunca sobrescribe un
`.env` existente.

> `ENCRYPTION_KEY` cifra los tokens de WhatsApp de cada empresa y los secretos
> de segundo factor. **Si la pierdes, esos datos son irrecuperables.** Guárdala
> fuera de la base de datos y fuera del repositorio.

### 2 · Infraestructura

```bash
docker compose --env-file .env -f infra/compose.yml up -d
```

Levanta Postgres 16 con pgvector, Redis, MinIO y Mailpit. La web, la API y el
worker corren fuera del contenedor para conservar la recarga en caliente.

### 3 · Dependencias y base de datos

```bash
pnpm install && pnpm db:migrate && pnpm db:seed
```

`db:migrate` aplica las migraciones de Prisma **y a continuación** los scripts
de `packages/database/prisma/sql/` — las políticas RLS, los triggers y los
índices que Prisma no sabe expresar. Nunca se ejecuta uno sin el otro: una
tabla nueva sin su política es un agujero de aislamiento, y el script lo
detecta y aborta.

### 4 · Arrancar

```bash
pnpm dev
```

|                         |                                  |
| ----------------------- | -------------------------------- |
| Producto                | <http://localhost:3000/login>    |
| Panel de plataforma     | <http://localhost:3000/admin>    |
| API                     | <http://localhost:4000/api/v1>   |
| Documentación de la API | <http://localhost:4000/api/docs> |
| Correos capturados      | <http://localhost:8025>          |
| Consola de MinIO        | <http://localhost:9001>          |

**Cuentas del seed** — contraseña `Desarrollo123!` en todas:

| Correo                | Rol           | Para probar                           |
| --------------------- | ------------- | ------------------------------------- |
| `sebastian@acme.test` | Propietario   | Acceso total, incluida la suscripción |
| `ana@acme.test`       | Administrador | Todo el producto, sin tocar el plan   |
| `pedro@acme.test`     | Responsable   | Alcance limitado a su equipo          |
| `lucia@acme.test`     | Agente        | Sólo sus propios registros            |
| `directora@acme.test` | Invitado      | Sólo lectura                          |
| `admin@nexo.local`    | Plataforma    | Panel global                          |

El seed crea además una **segunda empresa** (`boreal`). No es decorativa: es
contra la que corren las pruebas de aislamiento. Entra con `owner@boreal.test`
y comprueba que no existe ni rastro de los datos de Acme.

---

## Cambiar el esquema de la base de datos

1. Edita `packages/database/prisma/schema.prisma`.
2. `pnpm db:migration:new nombre_descriptivo` genera la migración y avisa si el
   SQL fallaría sobre tablas con datos o si borra datos.
3. Revísala, y reescríbela si hace falta (ver
   `prisma/migrations/20260917000000_tenant_id_en_permisos_y_facturas`).
4. `pnpm db:migrate` la aplica, junto con las políticas RLS de las tablas nuevas.

> **No ejecutes `prisma migrate dev`.** Ve como sobrantes los índices de búsqueda
> y de vectores que se crean por SQL, y ofrece **reiniciar la base de datos**,
> borrando todos los datos. El motivo completo está en
> [`docs/arquitectura.md`](docs/arquitectura.md).

---

## Cómo se aíslan las empresas

Es la decisión de la que depende todo lo demás, así que conviene entenderla
antes de tocar código.

El filtro por empresa se aplica **tres veces, de forma independiente**. Las dos
primeras son de aplicación; la tercera no se puede saltar desde el código.

**1 · Contexto de petición** — `packages/database/src/tenant-context.ts`
Un guard resuelve la empresa desde el JWT, comprueba que el usuario tenga
membresía activa y la deposita en un `AsyncLocalStorage` que acompaña a toda la
petición, incluidos los trabajos que se encolen desde ella.

**2 · Extensión de Prisma** — `packages/database/src/client.ts`
Inyecta `tenantId` en los `where` y los `data` de toda consulta a un modelo con
ámbito de empresa. La lista de esos modelos **se deriva del propio esquema** en
tiempo de arranque, leyendo el DMMF de Prisma: añadir un modelo con `tenantId`
basta para que quede protegido, y no hay ningún registro donde olvidarse de
apuntarlo.

**3 · Row Level Security** — `packages/database/prisma/sql/01_rls.sql`
La red de seguridad real. Cada transacción abre fijando `app.tenant_id`, y cada
tabla tiene su política. La aplicación conecta con el rol `nexo_app`, que **no
tiene `BYPASSRLS`** y no es dueño de las tablas — sin eso, `FORCE ROW LEVEL
SECURITY` no serviría de nada.

Ese script tampoco lleva una lista escrita a mano: recorre el catálogo de
Postgres, aplica la política a toda tabla con `tenant_id NOT NULL`, y al final
**verifica que no quede ninguna sin cubrir, abortando el despliegue si la hay**.

```bash
pnpm --filter @nexo/database verify-rls
```

Ese comando corre en CI y en el arranque de la API. Devuelve código distinto de
cero si encuentra un agujero, así que un despliegue con una tabla desprotegida
no llega a producción.

**Las excepciones son explícitas.** Seis tablas quedan fuera a propósito
(`user`, `refresh_token`, `webhook_event`, los planes y el operador de
plataforma), cada una con su motivo escrito en `_rls_excluded_tables()`. Si
aparece un modelo con `tenantId` nulable que nadie declaró como excepción, el
cliente de Prisma **falla al arrancar** en vez de dejarlo pasar.

---

## Estructura

```
apps/
  web/        Next.js 15 · App Router
  api/        NestJS · REST + WebSocket
  worker/     Procesadores BullMQ
packages/
  database/   Esquema Prisma, migraciones, RLS, seed
  contracts/  Esquemas zod y permisos compartidos web ⇄ api ⇄ worker
  design/     Tokens de color, tipografía y espaciado
  ...
infra/        Docker, Nginx, scripts de despliegue
docs/         Arquitectura, API, despliegue, runbooks
```

Cada módulo de negocio tiene **la misma forma** en todas partes: en la API,
`controller · service · dto · policy · events`; en la web, `hooks · schemas ·
views`. Abrir un módulo que no conoces no debería obligarte a reaprender dónde
está nada.

---

## Comandos

| Comando                          | Qué hace                                                             |
| -------------------------------- | -------------------------------------------------------------------- |
| `pnpm dev`                       | Web, API y worker con recarga en caliente                            |
| `pnpm build`                     | Compila todo                                                         |
| `pnpm typecheck`                 | Comprueba tipos en todo el monorepo                                  |
| `pnpm lint`                      | ESLint con información de tipos y reglas de seguridad                |
| `pnpm format`                    | Aplica el formato de Prettier                                        |
| `pnpm check`                     | **Formato + lint + tipos: el trabajo "Calidad" del CI**              |
| `pnpm ci:local`                  | **La integración completa del CI, en contenedores desechables**      |
| `pnpm db:migrate`                | Aplica migraciones pendientes + scripts SQL (RLS, triggers, índices) |
| `pnpm db:migration:new <nombre>` | **Genera una migración** a partir de los cambios en `schema.prisma`  |
| `pnpm db:seed`                   | Datos de desarrollo                                                  |
| `pnpm db:reset`                  | Borra, migra y siembra de cero                                       |
| `pnpm db:studio`                 | Explorador visual de la base de datos                                |

---

## Integración continua

Cada push a `main` y cada Pull Request ejecutan dos trabajos en paralelo
([`.github/workflows/ci.yml`](.github/workflows/ci.yml)):

| Trabajo         | Qué comprueba                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Calidad**     | Formato, lint, tipos y build de producción de los seis paquetes                                                                                                                                                                                                                                                                                                                                                                                       |
| **Integración** | Sobre una base de datos **vacía**: rol de aplicación, migraciones, RLS, seed, prueba de aislamiento (29 comprobaciones), alta de empresa (6), API real (sondas, errores RFC 7807, cabeceras), worker real, autenticación de extremo a extremo (61), equipo y permisos con escaladas (65), CRM con alcance por rol, agenda y notas (64), prueba de humo (14 comprobaciones), web de producción con pruebas de navegador (Playwright) y cierre ordenado |

La integración es un script, no YAML: `pnpm ci:local` ejecuta exactamente lo
mismo en tu máquina, con contenedores desechables en puertos propios que no
tocan tu entorno de desarrollo. Si falla en CI, falla igual en local.

Las acciones de GitHub están fijadas por hash de commit, no por etiqueta.

---

## Antes de abrir un Pull Request

- [ ] `pnpm check` en verde
- [ ] `pnpm ci:local` en verde — **incluye la prueba de aislamiento entre empresas**
- [ ] Si añadiste un modelo con `tenantId`: `pnpm db:migrate` y comprobar que
      `verify-rls` lo cubre
- [ ] Las vistas nuevas resuelven sus cuatro estados: cargando, vacío, error y
      con datos
- [ ] Revisado en modo claro **y** oscuro

---

## Licencia

Software propietario. Todos los derechos reservados.
