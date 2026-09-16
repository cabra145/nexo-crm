#!/bin/bash
# =============================================================================
#  Crea el rol de aplicación al inicializar el contenedor.
# -----------------------------------------------------------------------------
#  Corre UNA sola vez, cuando se crea el volumen de datos. Si cambias algo de
#  aquí, hay que recrear el volumen:
#
#      docker compose -f infra/compose.yml down -v
#
#  El punto entero de este script es que la aplicación NO conecte con el rol
#  dueño de las tablas. Con `FORCE ROW LEVEL SECURITY`, el dueño sí respeta las
#  políticas — pero sólo si además no tiene BYPASSRLS ni es superusuario, y el
#  rol que crea POSTGRES_USER es superusuario. De ahí este segundo rol.
# =============================================================================
set -euo pipefail

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
    -- Rol de la aplicación: puede leer y escribir datos, nada más.
    DO \$\$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nexo_app') THEN
        CREATE ROLE nexo_app LOGIN PASSWORD '${POSTGRES_APP_PASSWORD}' NOBYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE;
      ELSE
        ALTER ROLE nexo_app PASSWORD '${POSTGRES_APP_PASSWORD}' NOBYPASSRLS NOSUPERUSER;
      END IF;
    END
    \$\$;

    GRANT CONNECT ON DATABASE ${POSTGRES_DB} TO nexo_app;
    GRANT USAGE ON SCHEMA public TO nexo_app;

    -- NO se concede CREATE sobre el esquema: la aplicación no debe poder
    -- alterar la estructura. Eso es trabajo de las migraciones, que corren
    -- con DIRECT_DATABASE_URL.
    REVOKE CREATE ON SCHEMA public FROM nexo_app;

    -- El resto de permisos (SELECT/INSERT/UPDATE/DELETE sobre las tablas) los
    -- concede prisma/sql/01_rls.sql, porque las tablas todavía no existen.
EOSQL

echo "Rol nexo_app creado (NOBYPASSRLS, sin permiso para alterar el esquema)."
