-- ============================================================================
--  Nexo CRM · Aislamiento entre empresas (Row Level Security)
-- ----------------------------------------------------------------------------
--  Se aplica DESPUÉS de `prisma migrate deploy`, porque Prisma no expresa
--  políticas RLS y las regenera perdidas en cada migración de esquema.
--
--    pnpm db:rls        → aplica este archivo
--    pnpm db:deploy     → migrate deploy + db:rls (nunca uno sin el otro)
--
--  Es IDEMPOTENTE: se puede correr en cada despliegue, y de hecho se corre.
--
--  ---------------------------------------------------------------------------
--  Por qué esto se genera y no se escribe a mano
--
--  Un CRM multiempresa muere el día que una tabla nueva se olvida de su
--  política. Escribir 55 bloques CREATE POLICY a mano garantiza que la 56ª se
--  olvide. Así que aquí NO hay una lista: el script recorre el catálogo de
--  Postgres, aplica la política a toda tabla que tenga una columna `tenant_id`
--  NOT NULL, y al final VERIFICA que no quede ninguna sin cubrir — abortando
--  el despliegue si la hay.
--
--  El resultado: añadir un modelo con `tenantId` al schema.prisma es
--  suficiente. Olvidarse es imposible.
-- ============================================================================

-- ----------------------------------------------------------------------------
--  1 · Tablas que quedan deliberadamente FUERA del aislamiento
--
--  Cada exclusión es una decisión, no un descuido. Si alguna vez una de estas
--  necesita RLS, se quita de aquí y el script la cubre sola.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION _rls_excluded_tables()
RETURNS text[]
LANGUAGE sql IMMUTABLE
AS $$
  SELECT ARRAY[
    -- Datos de la plataforma, no de ninguna empresa cliente:
    'plan',
    'plan_feature',
    'platform_admin',
    'subscription_invoice',   -- alcanzada vía subscription, que sí lleva RLS
    '_prisma_migrations',

    -- `tenant` no se filtra por tenant_id (no lo tiene): lleva su propia
    -- política más abajo, comparando contra su `id`.
    'tenant',

    -- tenant_id NULABLE a propósito: se escriben ANTES de saber a qué empresa
    -- pertenecen. El filtrado es de aplicación y está probado aparte.
    --   refresh_token → la sesión existe antes de elegir espacio de trabajo
    --   webhook_event → el webhook de Meta se persiste antes de resolverlo
    'refresh_token',
    'webhook_event',

    -- Identidad global: una persona puede estar en varias empresas. El acceso
    -- se controla por `membership`, que sí lleva RLS.
    'user',
    'totp_secret',
    'email_token'
  ];
$$;

-- ----------------------------------------------------------------------------
--  2 · Aplicación de las políticas
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  r          record;
  n_applied  int := 0;
BEGIN
  FOR r IN
    SELECT c.relname AS table_name
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid
    WHERE n.nspname = 'public'
      AND c.relkind IN ('r', 'p')              -- tablas normales y particionadas
      AND a.attname = 'tenant_id'
      AND a.attnotnull                         -- sólo las de tenant_id obligatorio
      AND NOT a.attisdropped
      AND c.relname <> ALL (_rls_excluded_tables())
    ORDER BY c.relname
  LOOP
    -- ENABLE activa las políticas; FORCE las aplica TAMBIÉN al dueño de la
    -- tabla. Sin FORCE, el propietario las ignora y todo esto es decorativo.
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', r.table_name);
    EXECUTE format('ALTER TABLE public.%I FORCE  ROW LEVEL SECURITY', r.table_name);

    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON public.%I', r.table_name);

    -- USING      → filtra lo que se puede LEER, actualizar y borrar
    -- WITH CHECK → impide ESCRIBIR una fila de otra empresa
    --
    -- Ambas cláusulas son necesarias. Con sólo USING, un UPDATE podría mover
    -- una fila propia al tenant_id de otro.
    EXECUTE format($pol$
      CREATE POLICY tenant_isolation ON public.%I
        FOR ALL
        USING      (tenant_id = current_tenant_id())
        WITH CHECK (tenant_id = current_tenant_id())
    $pol$, r.table_name);

    n_applied := n_applied + 1;
  END LOOP;

  -- Cero tablas NUNCA es un resultado correcto: significa que el script no
  -- reconoce la columna de empresa (por ejemplo, si las columnas quedaran en
  -- camelCase — "tenantId" — en vez de tenant_id). Sin esta comprobación, el
  -- script "terminaría bien" sin haber protegido nada.
  IF n_applied = 0 THEN
    RAISE EXCEPTION 'RLS · no se encontró NINGUNA tabla con columna tenant_id NOT NULL. '
      'Revisa que schema.prisma mapee los campos a snake_case con @map. '
      'No se ha protegido nada.';
  END IF;

  RAISE NOTICE 'RLS · políticas aplicadas a % tablas', n_applied;
END
$$;

-- ----------------------------------------------------------------------------
--  3 · `tenant`: la tabla raíz
--
--  No tiene `tenant_id` porque ELLA es la empresa. Su política compara contra
--  su propia clave primaria, de modo que una sesión sólo ve su propia fila.
--
--  El INSERT va aparte, y esto NO es un descuido:
--
--  Registrarse es, por definición, la única operación que ocurre ANTES de que
--  exista la empresa a la que pertenecer. Con una política única `FOR ALL`
--  cuyo WITH CHECK exigiera `id = current_tenant_id()`, crear una empresa sería
--  imposible para todo el mundo —incluido el propio registro y el seed— porque
--  en ese instante no hay contexto que fijar.
--
--  Así que el INSERT se permite siempre, y las otras tres operaciones siguen
--  restringidas a la fila propia. El resultado: cualquiera puede darse de alta,
--  nadie puede leer, modificar ni borrar la empresa de otro.
-- ----------------------------------------------------------------------------
ALTER TABLE public.tenant ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tenant FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_self_isolation ON public.tenant;
DROP POLICY IF EXISTS tenant_select ON public.tenant;
DROP POLICY IF EXISTS tenant_insert ON public.tenant;
DROP POLICY IF EXISTS tenant_update ON public.tenant;
DROP POLICY IF EXISTS tenant_delete ON public.tenant;

CREATE POLICY tenant_select ON public.tenant
  FOR SELECT USING (id = current_tenant_id());

CREATE POLICY tenant_insert ON public.tenant
  FOR INSERT WITH CHECK (true);

CREATE POLICY tenant_update ON public.tenant
  FOR UPDATE
  USING      (id = current_tenant_id())
  WITH CHECK (id = current_tenant_id());

CREATE POLICY tenant_delete ON public.tenant
  FOR DELETE USING (id = current_tenant_id());

-- ----------------------------------------------------------------------------
--  4 · Permisos del rol de aplicación
--
--  `nexo_app` puede leer y escribir, pero NO es dueño de las tablas y no tiene
--  BYPASSRLS. Es lo que convierte las políticas de arriba en una barrera real
--  en vez de en una sugerencia.
--
--  DDL y migraciones corren con otro rol (el dueño), por otra conexión.
-- ----------------------------------------------------------------------------
GRANT USAGE ON SCHEMA public TO nexo_app;

GRANT SELECT, INSERT, UPDATE, DELETE
  ON ALL TABLES IN SCHEMA public TO nexo_app;

GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO nexo_app;

-- Que las tablas futuras hereden estos permisos sin repetir el GRANT.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO nexo_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO nexo_app;

-- La tabla de migraciones es sólo del dueño: la aplicación no la toca.
REVOKE ALL ON TABLE public._prisma_migrations FROM nexo_app;

-- ----------------------------------------------------------------------------
--  5 · Verificación — aborta el despliegue si algo quedó sin cubrir
--
--  Esto es lo que hace que el sistema sea seguro por construcción y no por
--  disciplina. Si alguien añade un modelo con `tenantId` y este script no se
--  vuelve a correr, `pnpm db:verify-rls` falla en CI y el despliegue no sale.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION verify_tenant_isolation()
RETURNS TABLE (table_name text, problem text)
LANGUAGE sql STABLE
AS $$
  -- (a) Tablas con tenant_id obligatorio y sin RLS activada
  SELECT c.relname::text,
         'RLS no activada'::text
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_attribute a ON a.attrelid = c.oid
  WHERE n.nspname = 'public'
    AND c.relkind IN ('r', 'p')
    AND a.attname = 'tenant_id'
    AND a.attnotnull
    AND NOT a.attisdropped
    AND c.relname <> ALL (_rls_excluded_tables())
    AND NOT c.relrowsecurity

  UNION ALL

  -- (b) RLS activada pero SIN forzar: el dueño de la tabla la ignoraría
  SELECT c.relname::text,
         'RLS activada pero no forzada (FORCE)'::text
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_attribute a ON a.attrelid = c.oid
  WHERE n.nspname = 'public'
    AND c.relkind IN ('r', 'p')
    AND a.attname = 'tenant_id'
    AND a.attnotnull
    AND NOT a.attisdropped
    AND c.relname <> ALL (_rls_excluded_tables())
    AND c.relrowsecurity
    AND NOT c.relforcerowsecurity

  UNION ALL

  -- (c) Sin la política nombrada
  SELECT c.relname::text,
         'falta la política tenant_isolation'::text
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_attribute a ON a.attrelid = c.oid
  WHERE n.nspname = 'public'
    AND c.relkind IN ('r', 'p')
    AND a.attname = 'tenant_id'
    AND a.attnotnull
    AND NOT a.attisdropped
    AND c.relname <> ALL (_rls_excluded_tables())
    AND NOT EXISTS (
      SELECT 1 FROM pg_policy p
      WHERE p.polrelid = c.oid AND p.polname = 'tenant_isolation'
    )

  UNION ALL

  -- (d) El rol de aplicación con BYPASSRLS: anularía todo lo anterior
  SELECT 'nexo_app'::text,
         'el rol de aplicación tiene BYPASSRLS'::text
  FROM pg_roles
  WHERE rolname = 'nexo_app' AND rolbypassrls

  UNION ALL

  -- (e) Ninguna tabla con tenant_id. Las comprobaciones (a)–(c) buscan tablas
  --     con esa columna: si no hay ninguna, no encuentran problemas y la
  --     verificación "pasaría" sin haber comprobado nada. Un falso verde es
  --     peor que un rojo, así que se trata como el peor de los agujeros.
  SELECT '(esquema)'::text,
         'no hay ninguna tabla con columna tenant_id: nada está protegido'::text
  WHERE NOT EXISTS (
    SELECT 1
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid
    WHERE n.nspname = 'public'
      AND c.relkind IN ('r', 'p')
      AND a.attname = 'tenant_id'
      AND a.attnotnull
      AND NOT a.attisdropped
  );
$$;

COMMENT ON FUNCTION verify_tenant_isolation() IS
  'Devuelve filas sólo si hay un agujero de aislamiento. Vacío = correcto. Se ejecuta en CI y en cada despliegue.';

DO $$
DECLARE
  problems text;
  n int;
BEGIN
  SELECT count(*), string_agg(format('  · %s → %s', table_name, problem), E'\n')
    INTO n, problems
  FROM verify_tenant_isolation();

  IF n > 0 THEN
    RAISE EXCEPTION E'AISLAMIENTO INCOMPLETO — % problema(s):\n%\n\nEl despliegue se detiene aquí a propósito.', n, problems;
  END IF;

  RAISE NOTICE 'RLS · verificación superada: ningún agujero de aislamiento';
END
$$;
