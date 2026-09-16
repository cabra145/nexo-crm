-- ============================================================================
--  Migración 0 · Extensiones, funciones base y roles
-- ----------------------------------------------------------------------------
--  Esta migración va ANTES que la creación de tablas porque `uuid_generate_v7()`
--  se usa como valor por defecto de toda clave primaria.
--
--  Idempotente: se puede volver a aplicar sin efecto.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;    -- gen_random_bytes, digest
CREATE EXTENSION IF NOT EXISTS pg_trgm;     -- búsqueda por coincidencia parcial
CREATE EXTENSION IF NOT EXISTS btree_gin;   -- índices compuestos GIN
CREATE EXTENSION IF NOT EXISTS vector;      -- pgvector: embeddings del RAG

-- ----------------------------------------------------------------------------
--  uuid_generate_v7()
--
--  Postgres 18 trae uuidv7() nativo; en 16 lo implementamos. Un UUID v7 lleva
--  la marca de tiempo en los 48 bits altos, así que ordena cronológicamente.
--  Esto importa de verdad: una PK aleatoria (v4) esparce las inserciones por
--  todo el índice B-tree y lo fragmenta; una v7 inserta siempre al final.
--
--  Formato (RFC 9562):
--    48 bits  timestamp Unix en milisegundos
--     4 bits  versión (0111 = 7)
--    12 bits  aleatorios
--     2 bits  variante (10)
--    62 bits  aleatorios
-- ----------------------------------------------------------------------------
--  Construido sobre gen_random_uuid() en vez de ensamblar los 16 bytes a mano:
--  así la variante RFC 4122 y los 74 bits aleatorios ya vienen correctos del
--  generador criptográfico, y sólo sobrescribimos los 6 primeros bytes con la
--  marca de tiempo y el nibble de versión.
--
--  Nota sobre set_bit: Postgres numera los bits de un bytea desde el bit MENOS
--  significativo de cada byte. El nibble de versión es el alto del byte 6, o
--  sea los bits 52-55. v4 = 0100 → v7 = 0111 se consigue poniendo a 1 los
--  bits 52 y 53.
CREATE OR REPLACE FUNCTION uuid_generate_v7()
RETURNS uuid
LANGUAGE sql
VOLATILE
PARALLEL SAFE
AS $$
  SELECT encode(
    set_bit(
      set_bit(
        overlay(
          uuid_send(gen_random_uuid())
          PLACING substring(
            int8send(floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint)
            FROM 3
          )
          FROM 1 FOR 6
        ),
        52, 1
      ),
      53, 1
    ),
    'hex'
  )::uuid;
$$;

COMMENT ON FUNCTION uuid_generate_v7() IS
  'UUID v7 (RFC 9562): ordenable por tiempo. Evita la fragmentación de índice que causa v4.';

-- ----------------------------------------------------------------------------
--  current_tenant_id()
--
--  Lee la variable de sesión que la aplicación fija con SET LOCAL al abrir
--  cada transacción. Toda política RLS la usa.
--
--  Devuelve NULL si no está fijada, y una política que compara con NULL no
--  deja pasar ninguna fila. Es decir: **el fallo por defecto es no ver nada**,
--  que es exactamente lo que queremos si alguien olvida fijar el contexto.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION current_tenant_id()
RETURNS uuid
LANGUAGE sql
STABLE
PARALLEL SAFE
AS $$
  SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid;
$$;

COMMENT ON FUNCTION current_tenant_id() IS
  'Empresa activa en la transacción. NULL si no se fijó: las políticas RLS entonces no dejan pasar nada.';

-- ----------------------------------------------------------------------------
--  Roles
--
--  El rol de la aplicación NO es el dueño de las tablas y NO tiene BYPASSRLS.
--  Sin esta separación, FORCE ROW LEVEL SECURITY no serviría de nada: el
--  dueño de una tabla ignora sus propias políticas por defecto.
--
--  Las contraseñas se fijan en el despliegue (infra/scripts/vps-setup.sh),
--  nunca aquí.
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nexo_app') THEN
    CREATE ROLE nexo_app LOGIN NOBYPASSRLS;
  ELSE
    ALTER ROLE nexo_app NOBYPASSRLS;
  END IF;
END
$$;
