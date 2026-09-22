#!/usr/bin/env bash
# =============================================================================
#  Ejecuta en local la misma prueba de integración que el CI.
# -----------------------------------------------------------------------------
#      bash infra/scripts/ci-local.sh
#
#  Levanta Postgres, Redis y Mailpit en contenedores DESECHABLES con puertos
#  propios (55432, 56379, 51025/58025), así que no toca tu entorno de
#  desarrollo ni sus datos (la web se compila en apps/web/.next-ci y se sirve
#  en :43000, así que un `pnpm dev` en marcha tampoco se entera). Compila la
#  API y el worker, ejecuta
#  infra/scripts/ci-integration.sh sobre una base vacía y elimina los
#  contenedores al terminar, pase lo que pase.
# =============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

PREFIX="nexo-ci-local"
PG_PORT=55432
REDIS_PORT=56379
SMTP_PORT=51025
MAILPIT_PORT=58025
MINIO_PORT=59000
# La misma imagen que infra/compose.yml (ver allí por qué esa etiqueta).
MINIO_IMAGE=quay.io/minio/minio:RELEASE.2025-09-07T16-13-09Z

containers=("$PREFIX-postgres" "$PREFIX-redis" "$PREFIX-mailpit" "$PREFIX-minio")

teardown() {
  docker rm -f "${containers[@]}" >/dev/null 2>&1 || true
}
trap teardown EXIT

# En macOS, el equipo no se duerme mientras dura la prueba. Se vio fallar por
# eso: el Mac entró en reposo a mitad de ejecución, la prueba quedó parada seis
# minutos y, al despertar, los tiempos de espera ya habían vencido.
# `caffeinate -w` se retira solo cuando termina este script.
if command -v caffeinate >/dev/null 2>&1; then
  caffeinate -i -w $$ &
fi

for port in $PG_PORT $REDIS_PORT $SMTP_PORT $MAILPIT_PORT $MINIO_PORT 44000 44100 43000 44200 44201; do
  if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "El puerto $port está ocupado. Libéralo o detén la ejecución anterior." >&2
    exit 1
  fi
done

echo "▸ Servicios desechables"
teardown
docker run -d --rm --name "$PREFIX-postgres" -p "$PG_PORT:5432" \
  -e POSTGRES_DB=nexo -e POSTGRES_USER=nexo -e POSTGRES_PASSWORD=ci_owner_password \
  -e POSTGRES_INITDB_ARGS='--locale-provider=icu --icu-locale=es-EC --encoding=UTF8' \
  pgvector/pgvector:pg16 >/dev/null
docker run -d --rm --name "$PREFIX-redis" -p "$REDIS_PORT:6379" redis:7-alpine >/dev/null
docker run -d --rm --name "$PREFIX-mailpit" -p "$SMTP_PORT:1025" -p "$MAILPIT_PORT:8025" \
  axllent/mailpit:v1.31.1 >/dev/null
docker run -d --rm --name "$PREFIX-minio" -p "$MINIO_PORT:9000" \
  -e MINIO_ROOT_USER=ci_minio -e MINIO_ROOT_PASSWORD=ci_minio_password \
  "$MINIO_IMAGE" server /data >/dev/null

# El contenedor de Postgres se inicializa con un servidor temporal y luego lo
# reinicia; se espera al segundo "ready".
for _ in $(seq 1 60); do
  ready=$(docker logs "$PREFIX-postgres" 2>&1 | grep -c 'database system is ready to accept connections' || true)
  [[ "$ready" -ge 2 ]] && break
  sleep 1
done
echo "  ✓ Postgres :$PG_PORT · Redis :$REDIS_PORT · Mailpit :$MAILPIT_PORT · MinIO :$MINIO_PORT"

echo "▸ Chromium para las pruebas de navegador"
# Se descarga una vez (~/Library/Caches/ms-playwright); después no hace nada.
# Si la descarga falla (red), se sigue: si el navegador ya estaba instalado las
# pruebas corren, y si no, fallan diciendo que falta.
pnpm --silent --filter @nexo/web exec playwright install --no-shell chromium \
  || echo "  ! no se pudo descargar Chromium; se usa el ya instalado, si lo hay" >&2

echo "▸ Build de API y worker"
pnpm --silent turbo run build --filter=@nexo/api --filter=@nexo/worker --output-logs=errors-only

# `env -i`: la prueba corre SÓLO con estas variables, como en CI. Tu .env de
# desarrollo no interviene (y aunque se cargara, las variables ya definidas
# tienen prioridad sobre el archivo).
env -i PATH="$PATH" HOME="$HOME" \
  DATABASE_URL="postgresql://nexo_app:ci_app_password@127.0.0.1:$PG_PORT/nexo?schema=public" \
  DIRECT_DATABASE_URL="postgresql://nexo:ci_owner_password@127.0.0.1:$PG_PORT/nexo?schema=public" \
  REDIS_URL="redis://127.0.0.1:$REDIS_PORT" \
  SMTP_HOST=127.0.0.1 SMTP_PORT="$SMTP_PORT" MAILPIT_URL="http://127.0.0.1:$MAILPIT_PORT" \
  API_PORT=44000 WORKER_HEALTH_PORT=44100 WEB_PORT=43000 \
  META_GRAPH_URL=http://127.0.0.1:44200 \
  S3_ENDPOINT="http://127.0.0.1:$MINIO_PORT" S3_ACCESS_KEY=ci_minio S3_SECRET_KEY=ci_minio_password \
  CI_LOG_DIR="$ROOT/.ci-logs" \
  bash infra/scripts/ci-integration.sh
