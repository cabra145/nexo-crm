#!/usr/bin/env bash
# =============================================================================
#  Crea el .env de desarrollo con secretos aleatorios.
# -----------------------------------------------------------------------------
#      bash infra/scripts/init-env.sh
#
#  Parte de .env.example y sustituye cada marcador por un valor generado con
#  openssl. Garantiza tres cosas que a mano son fáciles de romper:
#
#    · cada secreto es distinto: reutilizar uno convierte una filtración en tres
#    · la contraseña de cada rol de Postgres queda IDÉNTICA en los dos sitios
#      donde aparece (la URL de conexión y la variable que usa Docker)
#    · las contraseñas usan sólo hexadecimal, así que no rompen la URL de
#      conexión con caracteres como / + @ :
#
#  NUNCA sobrescribe un .env existente: si perdieras ENCRYPTION_KEY, los datos
#  cifrados con ella serían irrecuperables.
#
#  Sólo para desarrollo. En producción los secretos se gestionan en el servidor.
# =============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

if [[ -f .env ]]; then
  echo "Ya existe un .env en $ROOT — no lo sobrescribo."
  echo "Si de verdad quieres regenerarlo, bórralo primero. Ten en cuenta que las"
  echo "contraseñas de Postgres quedaron fijadas al crear el volumen de Docker:"
  echo "habría que recrearlo también (docker compose ... down -v)."
  exit 1
fi

if ! command -v openssl >/dev/null 2>&1; then
  echo "Falta openssl, necesario para generar los secretos." >&2
  exit 1
fi

hex()    { openssl rand -hex "$1"; }
base64s() { openssl rand -base64 "$1" | tr -d '\n'; }

PG_OWNER_PASSWORD="$(hex 24)"
PG_APP_PASSWORD="$(hex 24)"
MINIO_PASSWORD="$(hex 24)"
ENCRYPTION_KEY="$(hex 32)"          # exactamente 64 caracteres hex, lo que exige el validador
JWT_ACCESS_SECRET="$(base64s 48)"
JWT_REFRESH_SECRET="$(base64s 48)"

# Permisos 600: el .env sólo lo lee tu usuario.
umask 077

# Delimitador `|` en sed: base64 puede contener `/` y `+`, pero nunca `|`.
sed \
  -e "s|postgresql://nexo_app:cambia_esta_clave@|postgresql://nexo_app:${PG_APP_PASSWORD}@|" \
  -e "s|postgresql://nexo:cambia_esta_clave@|postgresql://nexo:${PG_OWNER_PASSWORD}@|" \
  -e "s|^POSTGRES_PASSWORD=cambia_esta_clave$|POSTGRES_PASSWORD=${PG_OWNER_PASSWORD}|" \
  -e "s|^POSTGRES_APP_PASSWORD=cambia_esta_clave$|POSTGRES_APP_PASSWORD=${PG_APP_PASSWORD}|" \
  -e "s|^S3_SECRET_KEY=cambia_esta_clave$|S3_SECRET_KEY=${MINIO_PASSWORD}|" \
  -e "s|^ENCRYPTION_KEY=\"\"$|ENCRYPTION_KEY=\"${ENCRYPTION_KEY}\"|" \
  -e "s|^JWT_ACCESS_SECRET=\"\"$|JWT_ACCESS_SECRET=\"${JWT_ACCESS_SECRET}\"|" \
  -e "s|^JWT_REFRESH_SECRET=\"\"$|JWT_REFRESH_SECRET=\"${JWT_REFRESH_SECRET}\"|" \
  .env.example > .env

# --- Comprobación: que no quede ningún marcador sin sustituir ----------------
remaining=$(grep -cE 'cambia_esta_clave|^(ENCRYPTION_KEY|JWT_ACCESS_SECRET|JWT_REFRESH_SECRET)=""$' .env || true)
if [[ "$remaining" != "0" ]]; then
  rm -f .env
  echo "Error: quedaron $remaining marcador(es) sin sustituir. .env.example cambió de formato." >&2
  echo "No se ha creado ningún .env." >&2
  exit 1
fi

echo ".env creado en $ROOT (permisos 600)"
echo ""
echo "  · contraseña del rol dueño de Postgres (nexo)   generada"
echo "  · contraseña del rol de aplicación (nexo_app)   generada, distinta"
echo "  · contraseña de MinIO                           generada"
echo "  · ENCRYPTION_KEY                                64 caracteres hex"
echo "  · JWT_ACCESS_SECRET / JWT_REFRESH_SECRET        distintos entre sí"
echo ""
echo "Guarda una copia de ENCRYPTION_KEY fuera del repositorio: si se pierde,"
echo "los tokens de WhatsApp y los secretos 2FA cifrados con ella no se recuperan."
