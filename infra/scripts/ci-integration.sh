#!/usr/bin/env bash
# =============================================================================
#  Prueba de integración completa contra servicios REALES.
# -----------------------------------------------------------------------------
#  Es lo que ejecuta el CI, y se puede ejecutar igual en local contra
#  contenedores desechables. Parte de una base de datos VACÍA y recorre todo el
#  camino que recorrería un despliegue:
#
#     criptografía → rol de aplicación → migraciones → RLS, triggers e índices
#     → verificación → seed → aislamiento → alta de empresa → API (sondas y
#     errores) → worker → autenticación completa → equipo y permisos → CRM →
#     prueba
#     de humo → web en
#     producción + pruebas de navegador → cierre ordenado del worker
#
#  Requisitos previos:
#     · `pnpm install` y `pnpm build` ya ejecutados (usa los dist/ compilados,
#       que es lo que se despliega)
#     · Postgres con pgvector, Redis y Mailpit accesibles
#     · Chromium de Playwright instalado (`pnpm --filter @nexo/web exec
#       playwright install chromium`)
#
#  La web se compila aquí y no antes: NEXT_PUBLIC_API_URL se incrusta al
#  compilar y tiene que apuntar a la API de ESTA ejecución. Se compila en
#  .next-ci para no pisar el .next de un `pnpm dev` que esté en marcha.
#
#  Variables obligatorias: DATABASE_URL, DIRECT_DATABASE_URL, REDIS_URL.
#  Los secretos, si no llegan, se generan para esta ejecución.
#
#  Termina con código distinto de cero en el primer fallo, y deja los logs de
#  la API y el worker en $CI_LOG_DIR para poder leerlos.
# =============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

: "${DATABASE_URL:?Falta DATABASE_URL (rol de aplicación)}"
: "${DIRECT_DATABASE_URL:?Falta DIRECT_DATABASE_URL (rol dueño)}"
: "${REDIS_URL:?Falta REDIS_URL}"

# --- Valores por defecto de la ejecución -------------------------------------
export NODE_ENV="${NODE_ENV:-production}"
export LOG_LEVEL="${LOG_LEVEL:-info}"
export API_PORT="${API_PORT:-4000}"
export WORKER_HEALTH_PORT="${WORKER_HEALTH_PORT:-4100}"
export WEB_PORT="${WEB_PORT:-3000}"
# `localhost` y no 127.0.0.1, tanto aquí como en NEXT_PUBLIC_API_URL: la web y
# la API tienen que ser el mismo «sitio» para que el navegador envíe la cookie
# de refresco (SameSite=Lax).
export APP_URL="${APP_URL:-http://localhost:${WEB_PORT}}"
# La Graph API de Meta, simulada: whatsapp:e2e levanta un simulador en este
# puerto y la API lo consulta en lugar de a Meta. El CI no depende de Meta.
export META_GRAPH_URL="${META_GRAPH_URL:-http://127.0.0.1:44200}"
export SMTP_HOST="${SMTP_HOST:-localhost}"
export SMTP_PORT="${SMTP_PORT:-1025}"
export SMTP_FROM="${SMTP_FROM:-Nexo CRM <no-responder@nexo.test>}"
export MAILPIT_URL="${MAILPIT_URL:-http://localhost:8025}"
export ENCRYPTION_KEY="${ENCRYPTION_KEY:-$(openssl rand -hex 32)}"
export JWT_ACCESS_SECRET="${JWT_ACCESS_SECRET:-$(openssl rand -base64 48 | tr -d '\n')}"
export JWT_REFRESH_SECRET="${JWT_REFRESH_SECRET:-$(openssl rand -base64 48 | tr -d '\n')}"

CI_LOG_DIR="${CI_LOG_DIR:-$ROOT/.ci-logs}"
mkdir -p "$CI_LOG_DIR"

API_URL="http://127.0.0.1:${API_PORT}/api/v1"
WORKER_HEALTH_URL="http://127.0.0.1:${WORKER_HEALTH_PORT}/health"

WEB_URL="http://localhost:${WEB_PORT}"

API_PID=""
WORKER_PID=""
WEB_PID=""

# --- Utilidades --------------------------------------------------------------
step() { printf '\n\033[1;36m▸ %s\033[0m\n' "$1"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }
fail() {
  printf '  \033[31m✗ %s\033[0m\n' "$1" >&2
  for log in api worker web; do
    if [[ -s "$CI_LOG_DIR/$log.log" ]]; then
      printf '\n--- últimas líneas de %s.log ---\n' "$log" >&2
      tail -n 40 "$CI_LOG_DIR/$log.log" >&2
    fi
  done
  exit 1
}

cleanup() {
  [[ -n "$API_PID" ]] && kill "$API_PID" 2>/dev/null || true
  [[ -n "$WORKER_PID" ]] && kill "$WORKER_PID" 2>/dev/null || true
  [[ -n "$WEB_PID" ]] && kill "$WEB_PID" 2>/dev/null || true
  wait 2>/dev/null || true
}
trap cleanup EXIT

# Espera hasta que una URL responda 2xx, o hasta que el proceso muera.
wait_for() {
  local url="$1" pid="$2" name="$3" seconds="${4:-60}"
  for _ in $(seq 1 "$seconds"); do
    if ! kill -0 "$pid" 2>/dev/null; then
      fail "$name terminó antes de estar listo"
    fi
    if curl -fsS -o /dev/null "$url" 2>/dev/null; then
      return 0
    fi
    sleep 1
  done
  fail "$name no respondió en $url tras ${seconds} s"
}

# --- 0 · Criptografía propia ---------------------------------------------------
step "Criptografía contra vectores oficiales (RFC 4226, 6238, 4648)"
pnpm --silent --filter @nexo/api crypto:selftest || fail "crypto:selftest"

# --- 1 · Base de datos --------------------------------------------------------
step "Rol de aplicación"
pnpm --silent --filter @nexo/database create-app-role || fail "no se pudo crear el rol nexo_app"

step "Migraciones"
pnpm --silent --filter @nexo/database run prisma migrate deploy || fail "prisma migrate deploy"

step "Políticas RLS, triggers e índices"
pnpm --silent --filter @nexo/database sql || fail "scripts SQL"

step "Verificación de aislamiento"
pnpm --silent --filter @nexo/database verify-rls || fail "verify-rls"

step "Datos de prueba"
pnpm --silent --filter @nexo/database seed || fail "seed"

step "Prueba de aislamiento contra la base real"
pnpm --silent --filter @nexo/database test:isolation || fail "test:isolation"

step "Alta de empresa con Prisma y el rol de aplicación"
pnpm --silent --filter @nexo/database test:tenant-creation || fail "test:tenant-creation"

# --- 2 · API ------------------------------------------------------------------
step "API"
node apps/api/dist/main.js > "$CI_LOG_DIR/api.log" 2>&1 &
API_PID=$!
wait_for "$API_URL/health" "$API_PID" "La API"
ok "arrancó (pid $API_PID)"

readiness_status=$(curl -s -o "$CI_LOG_DIR/ready.json" -w '%{http_code}' "$API_URL/health/ready")
[[ "$readiness_status" == "200" ]] || { cat "$CI_LOG_DIR/ready.json" >&2; fail "/health/ready respondió $readiness_status"; }
grep -q '"status":"ready"' "$CI_LOG_DIR/ready.json" || fail "/health/ready no dice ready"
ok "/health/ready → 200, base de datos, Redis y aislamiento operativos"

not_found_headers=$(curl -s -D - -o "$CI_LOG_DIR/404.json" "$API_URL/ruta-que-no-existe")
grep -qi '^HTTP/1.1 404' <<<"$not_found_headers" || fail "una ruta inexistente no devolvió 404"
grep -qi '^content-type: application/problem+json' <<<"$not_found_headers" || fail "el 404 no es application/problem+json"
trace_header=$(grep -i '^x-trace-id:' <<<"$not_found_headers" | awk '{print $2}' | tr -d '\r')
[[ -n "$trace_header" ]] || fail "falta la cabecera X-Trace-Id"
grep -q "\"traceId\":\"$trace_header\"" "$CI_LOG_DIR/404.json" || fail "el traceId del cuerpo no coincide con la cabecera"
ok "errores en RFC 7807 con traceId coincidente"

grep -qi '^x-powered-by' <<<"$not_found_headers" && fail "la API anuncia X-Powered-By"
grep -qi '^x-content-type-options: nosniff' <<<"$not_found_headers" || fail "faltan las cabeceras de seguridad"
ok "cabeceras de seguridad presentes, sin X-Powered-By"

# CORS: el navegador pregunta antes de enviar la cabecera anti-CSRF. Si la API
# no la permite, la web no puede renovar la sesión (y ninguna prueba en Node lo
# notaría: fetch en Node no aplica CORS).
preflight=$(curl -s -D - -o /dev/null -X OPTIONS "$API_URL/auth/refresh" \
  -H "Origin: $(node -p "new URL(process.env.APP_URL).origin")" \
  -H 'Access-Control-Request-Method: POST' \
  -H 'Access-Control-Request-Headers: content-type,x-nexo-client')
grep -qi '^access-control-allow-headers:.*x-nexo-client' <<<"$preflight" \
  || fail "CORS no permite la cabecera x-nexo-client"
grep -qi '^access-control-allow-credentials: true' <<<"$preflight" \
  || fail "CORS no permite credenciales"
ok "CORS: la web puede enviar la cabecera anti-CSRF y la cookie"

# --- 3 · Worker ---------------------------------------------------------------
step "Worker"
node apps/worker/dist/main.js > "$CI_LOG_DIR/worker.log" 2>&1 &
WORKER_PID=$!
wait_for "$WORKER_HEALTH_URL" "$WORKER_PID" "El worker"
ok "arrancó y su sonda responde (pid $WORKER_PID)"

step "Autenticación de extremo a extremo (incluidos ataques)"
pnpm --silent --filter @nexo/api auth:e2e || fail "auth:e2e"

step "Equipo y permisos de extremo a extremo (incluidas escaladas)"
pnpm --silent --filter @nexo/api rbac:e2e || fail "rbac:e2e"

step "CRM de extremo a extremo (alcance por rol, cuotas, búsqueda)"
pnpm --silent --filter @nexo/api crm:e2e || fail "crm:e2e"

step "Embudo de ventas de extremo a extremo (orden del tablero y reequilibrio)"
pnpm --silent --filter @nexo/api deals:e2e || fail "deals:e2e"

step "WhatsApp de extremo a extremo (simulador de Meta, firma, idempotencia)"
pnpm --silent --filter @nexo/api whatsapp:e2e || fail "whatsapp:e2e"

step "Prueba de humo del worker"
pnpm --silent --filter @nexo/worker smoke || fail "prueba de humo"
# Un reintento idempotente es un caso normal, no un error: no puede dejar
# errores de Prisma en el log (antes dejaba un «Unique constraint failed»).
if grep -q 'prisma:error' "$CI_LOG_DIR/worker.log"; then
  grep -A4 'prisma:error' "$CI_LOG_DIR/worker.log" >&2
  fail "el worker registró errores de Prisma"
fi
ok "sin errores de Prisma en el log del worker"

# --- 4 · Web ------------------------------------------------------------------
step "Web: build de producción contra la API de esta ejecución"
# Primero sus paquetes (sistema de diseño, contratos) con turbo; la web, con
# `next build` directo: turbo filtra las variables no declaradas y
# NEXT_DIST_DIR no llegaría.
pnpm --silent turbo run build --filter='@nexo/web^...' --output-logs=errors-only \
  || fail "build de los paquetes de la web"
NEXT_DIST_DIR=.next-ci NEXT_PUBLIC_API_URL="http://localhost:${API_PORT}/api/v1" \
  pnpm --silent --filter @nexo/web exec next build > "$CI_LOG_DIR/web-build.log" 2>&1 \
  || { tail -n 40 "$CI_LOG_DIR/web-build.log" >&2; fail "next build"; }
ok "compilada en apps/web/.next-ci"

NEXT_DIST_DIR=.next-ci pnpm --silent --filter @nexo/web exec next start --port "$WEB_PORT" \
  > "$CI_LOG_DIR/web.log" 2>&1 &
WEB_PID=$!
wait_for "$WEB_URL/login" "$WEB_PID" "La web"
ok "arrancó en $WEB_URL (pid $WEB_PID)"

step "Pruebas de navegador (Playwright · Chromium)"
# Todas las suites entran desde 127.0.0.1: sin esto, Playwright hereda los
# intentos de inicio de sesión de las anteriores y pasa del límite por IP.
pnpm --silent --filter @nexo/api exec tsx scripts/reset-login-ip-limits.ts \
  || fail "reiniciar el límite de inicio de sesión por IP"
WEB_URL="$WEB_URL" MAILPIT_URL="$MAILPIT_URL" \
  pnpm --silent --filter @nexo/web test:e2e || fail "pruebas de navegador"
kill "$WEB_PID" 2>/dev/null || true
wait "$WEB_PID" 2>/dev/null || true
WEB_PID=""

step "Cierre ordenado del worker"
kill -TERM "$WORKER_PID"
worker_exit=0
wait "$WORKER_PID" || worker_exit=$?
WORKER_PID=""
[[ "$worker_exit" == "0" ]] || fail "el worker salió con código $worker_exit al recibir SIGTERM"
grep -q 'Worker detenido' "$CI_LOG_DIR/worker.log" || fail "el worker no completó el cierre ordenado"
ok "SIGTERM → terminó los trabajos en curso y salió con código 0"

printf '\n\033[1;32mIntegración completa superada.\033[0m\n'
