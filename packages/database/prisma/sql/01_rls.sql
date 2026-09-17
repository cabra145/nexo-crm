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
--  Dar de alta una empresa NO necesita permisos especiales, aunque en el
--  momento de registrarse todavía no exista la empresa a la que pertenecer:
--
--    1. se genera el id ANTES de insertar     SELECT uuid_generate_v7()
--    2. se fija ese id como contexto          set_config('app.tenant_id', id, true)
--    3. se inserta la empresa con ese id      INSERT INTO tenant (id, …)
--
--  Así el INSERT cumple la misma regla que todo lo demás —sólo la fila del
--  contexto—, y también el RETURNING que usa Prisma, que exige que la fila
--  devuelta pase la política de LECTURA.
--
--  (Una versión anterior permitía el INSERT sin condición, `WITH CHECK (true)`,
--  porque parecía la única forma de registrarse. No lo era, y esa excepción
--  dejaba insertar empresas arbitrarias desde cualquier sesión.)
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
  FOR INSERT WITH CHECK (id = current_tenant_id());

CREATE POLICY tenant_update ON public.tenant
  FOR UPDATE
  USING      (id = current_tenant_id())
  WITH CHECK (id = current_tenant_id());

CREATE POLICY tenant_delete ON public.tenant
  FOR DELETE USING (id = current_tenant_id());

-- ----------------------------------------------------------------------------
--  3b · Lo que un usuario autenticado puede ver de SÍ MISMO, sin empresa activa
--
--  Al iniciar sesión todavía no hay empresa en el contexto, pero hay que
--  saber a cuáles pertenece el usuario para ofrecérselas. Con sólo las
--  políticas por empresa, `membership` devolvería cero filas y el usuario no
--  podría ver ni sus propias empresas.
--
--  Solución: una segunda identidad en el contexto, `app.user_id`, que la API
--  fija SÓLO después de verificar la contraseña (y el 2FA). Con ella, y en
--  modo exclusivamente de LECTURA, el usuario ve:
--
--    · sus propias membresías
--    · las empresas a las que pertenece
--    · los roles que tiene asignados
--
--  Nada más. Contactos, oportunidades y el resto de datos de negocio siguen
--  exigiendo `app.tenant_id`. Y ninguna de estas políticas permite escribir:
--  las altas y cambios de membresía se hacen con contexto de empresa.
--
--  Las políticas permisivas de Postgres se combinan con OR: estas se SUMAN a
--  la de empresa, no la sustituyen.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION current_user_id()
RETURNS uuid
LANGUAGE sql
STABLE
PARALLEL SAFE
AS $$
  SELECT NULLIF(current_setting('app.user_id', true), '')::uuid;
$$;

COMMENT ON FUNCTION current_user_id() IS
  'Usuario autenticado en la transacción. NULL si no se fijó: las políticas de lectura propia no dejan pasar nada.';

DROP POLICY IF EXISTS membership_self_select ON public.membership;
CREATE POLICY membership_self_select ON public.membership
  FOR SELECT USING (user_id = current_user_id());

DROP POLICY IF EXISTS tenant_member_select ON public.tenant;
CREATE POLICY tenant_member_select ON public.tenant
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.membership m
      WHERE m.tenant_id = tenant.id AND m.user_id = current_user_id()
    )
  );

DROP POLICY IF EXISTS role_member_select ON public.role;
CREATE POLICY role_member_select ON public.role
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.membership m
      WHERE m.role_id = role.id AND m.user_id = current_user_id()
    )
  );

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

  -- (f) Tablas con datos de empresa SIN columna tenant_id.
  --
  --     Las comprobaciones (a)–(c) sólo ven tablas que YA tienen tenant_id. Una
  --     tabla hija que llega a la empresa a través de su padre —como era
  --     role_permission a través de role— les es invisible, y queda fuera de
  --     la RLS sin que nada avise. La señal es estructural: tiene una clave
  --     foránea hacia una tabla protegida, pero no tiene tenant_id propio.
  SELECT DISTINCT c.relname::text,
         format('referencia a %I, que está protegida, pero no tiene tenant_id propio: queda fuera de la RLS', rc.relname)
  FROM pg_constraint k
  JOIN pg_class c      ON c.oid = k.conrelid
  JOIN pg_namespace n  ON n.oid = c.relnamespace
  JOIN pg_class rc     ON rc.oid = k.confrelid
  WHERE k.contype = 'f'
    AND n.nspname = 'public'
    AND c.relkind IN ('r', 'p')
    AND rc.relrowsecurity
    AND c.relname <> ALL (_rls_excluded_tables())
    AND NOT EXISTS (
      SELECT 1 FROM pg_attribute a
      WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND a.attnotnull AND NOT a.attisdropped
    )

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
