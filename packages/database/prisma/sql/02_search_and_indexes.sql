-- ============================================================================
--  Nexo CRM · Búsqueda, columnas derivadas e índices especializados
-- ----------------------------------------------------------------------------
--  Lo que Prisma no sabe expresar: triggers, tsvector, índices trigram y el
--  índice HNSW de pgvector. Se aplica después de cada migración, igual que RLS.
--
--  Idempotente.
-- ============================================================================

-- ============================================================================
--  1 · CONTACTOS · nombre completo derivado
-- ----------------------------------------------------------------------------
--  `full_name` podría ser una columna GENERATED ALWAYS, pero entonces Prisma
--  fallaría al intentar escribirla en cada INSERT. Con un trigger BEFORE, la
--  aplicación puede mandar lo que quiera y la base siempre gana.
-- ============================================================================
CREATE OR REPLACE FUNCTION contact_sync_derived()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.full_name := trim(both ' ' FROM coalesce(NEW.first_name, '') || ' ' || coalesce(NEW.last_name, ''));

  -- Índice de texto completo. Los pesos ordenan la relevancia:
  --   A → nombre (lo que más se busca)
  --   B → empresa y correo
  --   C → teléfonos y cargo
  --
  -- 'spanish' aplica lematización y descarta artículos. Para los teléfonos
  -- usamos 'simple' porque no queremos que un diccionario los altere.
  NEW.search_vector :=
      setweight(to_tsvector('spanish', coalesce(NEW.full_name, '')),    'A')
   || setweight(to_tsvector('spanish', coalesce(NEW.company_name, '')), 'B')
   || setweight(to_tsvector('simple',  coalesce(NEW.email, '')),        'B')
   || setweight(to_tsvector('simple',  coalesce(NEW.phone_e164, '')),   'C')
   || setweight(to_tsvector('simple',  coalesce(NEW.whatsapp_e164, '')),'C')
   || setweight(to_tsvector('spanish', coalesce(NEW.job_title, '')),    'C');

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS contact_sync_derived_trg ON public.contact;
CREATE TRIGGER contact_sync_derived_trg
  BEFORE INSERT OR UPDATE OF first_name, last_name, company_name, email, phone_e164, whatsapp_e164, job_title
  ON public.contact
  FOR EACH ROW
  EXECUTE FUNCTION contact_sync_derived();

-- Búsqueda por palabras completas y prefijos: "juan per:*"
CREATE INDEX IF NOT EXISTS contact_search_idx
  ON public.contact USING gin (search_vector);

-- Coincidencia parcial en cualquier posición: buscar "erez" encuentra "Pérez".
-- El tsvector no puede hacer esto; trigram sí.
CREATE INDEX IF NOT EXISTS contact_name_trgm_idx
  ON public.contact USING gin (full_name gin_trgm_ops);

-- Buscar por los últimos dígitos de un teléfono, que es como la gente busca.
CREATE INDEX IF NOT EXISTS contact_phone_trgm_idx
  ON public.contact USING gin (phone_e164 gin_trgm_ops);

CREATE INDEX IF NOT EXISTS company_name_trgm_idx
  ON public.company USING gin (name gin_trgm_ops);

-- ============================================================================
--  2 · CAMPOS PERSONALIZADOS · índices sobre jsonb
-- ----------------------------------------------------------------------------
--  `jsonb_path_ops` ocupa bastante menos que el operador por defecto y es más
--  rápido para el único operador que usamos de verdad: @> (contiene).
-- ============================================================================
CREATE INDEX IF NOT EXISTS contact_custom_idx
  ON public.contact USING gin (custom jsonb_path_ops);

CREATE INDEX IF NOT EXISTS company_custom_idx
  ON public.company USING gin (custom jsonb_path_ops);

CREATE INDEX IF NOT EXISTS deal_custom_idx
  ON public.deal USING gin (custom jsonb_path_ops);

-- ============================================================================
--  3 · IA · índice vectorial
-- ----------------------------------------------------------------------------
--  HNSW frente a IVFFlat: HNSW no necesita entrenarse con datos previos (un
--  cliente nuevo tiene cero vectores el primer día) y da mejor recuperación.
--  Cuesta más construirlo y ocupa más, lo cual a esta escala da igual.
--
--  vector_cosine_ops porque los embeddings de OpenAI vienen normalizados y la
--  similitud coseno es la métrica correcta para ellos.
--
--    m               = 16  → conexiones por nodo (defecto, buen equilibrio)
--    ef_construction = 64  → calidad del grafo al construirlo
--
--  La consulta SIEMPRE filtra por tenant_id antes: el índice acelera el orden
--  por distancia, la RLS garantiza que sólo se ordenan trozos propios.
-- ============================================================================
CREATE INDEX IF NOT EXISTS ai_chunk_embedding_idx
  ON public.ai_chunk USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- Recuperación híbrida: cuando la similitud vectorial no basta, se combina con
-- búsqueda léxica sobre el mismo trozo.
CREATE INDEX IF NOT EXISTS ai_chunk_content_trgm_idx
  ON public.ai_chunk USING gin (content gin_trgm_ops);

-- ============================================================================
--  4 · CONVERSACIONES · índices parciales
-- ----------------------------------------------------------------------------
--  Un índice parcial sólo contiene las filas que cumplen la condición. La
--  bandeja consulta conversaciones abiertas; las resueltas son el 90 % de la
--  tabla al año y no tienen por qué estar en el índice.
-- ============================================================================
CREATE INDEX IF NOT EXISTS conversation_open_idx
  ON public.conversation (tenant_id, last_message_at DESC)
  WHERE status IN ('OPEN', 'PENDING');

CREATE INDEX IF NOT EXISTS conversation_unread_idx
  ON public.conversation (tenant_id, assignee_id)
  WHERE unread_count > 0;

-- Los mensajes pendientes de enviar son poquísimos frente al total.
CREATE INDEX IF NOT EXISTS message_pending_idx
  ON public.message (tenant_id, created_at)
  WHERE status IN ('QUEUED', 'SENT');

-- ============================================================================
--  5 · Índices parciales sobre borrado lógico
-- ----------------------------------------------------------------------------
--  Casi todas las consultas llevan `deleted_at IS NULL`. Un índice parcial
--  evita cargar con las filas borradas para siempre.
-- ============================================================================
CREATE INDEX IF NOT EXISTS contact_live_idx
  ON public.contact (tenant_id, created_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS deal_open_idx
  ON public.deal (tenant_id, pipeline_id, stage_id, position)
  WHERE deleted_at IS NULL AND status = 'OPEN';

CREATE INDEX IF NOT EXISTS task_pending_idx
  ON public.task (tenant_id, assignee_id, due_at)
  WHERE deleted_at IS NULL AND status IN ('PENDING', 'IN_PROGRESS');

-- ============================================================================
--  6 · Unicidad que Prisma no puede expresar
-- ----------------------------------------------------------------------------
--  La unicidad de correo y teléfono tiene que cumplir tres cosas a la vez:
--
--    a) ser por empresa                  → tenant_id en la clave
--    b) permitir muchos contactos sin
--       correo ni teléfono               → en Postgres los NULL no colisionan
--    c) IGNORAR los borrados             → borrar a juan@x.com debe permitir
--                                          volver a crearlo
--
--  (c) exige un índice PARCIAL, que Prisma no sabe declarar. Por eso estos
--  índices son la única fuente de unicidad y el schema.prisma no lleva
--  @@unique sobre estas columnas: si lo llevara, cada migración recrearía el
--  índice total y pisaría éstos.
--
--  `lower(email)` porque Juan@X.com y juan@x.com son la misma persona.
-- ============================================================================
CREATE UNIQUE INDEX IF NOT EXISTS contact_tenant_email_live_key
  ON public.contact (tenant_id, lower(email))
  WHERE deleted_at IS NULL AND email IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS contact_tenant_phone_live_key
  ON public.contact (tenant_id, phone_e164)
  WHERE deleted_at IS NULL AND phone_e164 IS NOT NULL;

-- Un solo embudo por defecto por empresa.
CREATE UNIQUE INDEX IF NOT EXISTS pipeline_one_default_key
  ON public.pipeline (tenant_id)
  WHERE is_default AND archived_at IS NULL;

-- Un solo impuesto por defecto por empresa.
CREATE UNIQUE INDEX IF NOT EXISTS tax_rate_one_default_key
  ON public.tax_rate (tenant_id)
  WHERE is_default AND active;

-- ============================================================================
--  7 · Integridad de negocio que el código no debe poder violar
-- ----------------------------------------------------------------------------
--  Una restricción CHECK en la base protege aunque falle la validación de la
--  aplicación, aunque alguien escriba por psql, y aunque una migración futura
--  introduzca un error.
-- ============================================================================
DO $$
BEGIN
  -- Probabilidad entre 0 y 100
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'deal_probability_range') THEN
    ALTER TABLE public.deal
      ADD CONSTRAINT deal_probability_range CHECK (probability BETWEEN 0 AND 100);
  END IF;

  -- Importes no negativos
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'deal_value_non_negative') THEN
    ALTER TABLE public.deal
      ADD CONSTRAINT deal_value_non_negative CHECK (value >= 0);
  END IF;

  -- Lo cobrado nunca puede superar el total del documento
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'document_paid_within_total') THEN
    ALTER TABLE public.document
      ADD CONSTRAINT document_paid_within_total
      CHECK (paid_amount >= 0 AND paid_amount <= total + 0.01);  -- margen por redondeo
  END IF;

  -- Un evento no puede terminar antes de empezar
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'event_ends_after_starts') THEN
    ALTER TABLE public.event
      ADD CONSTRAINT event_ends_after_starts CHECK (ends_at >= starts_at);
  END IF;

  -- Teléfonos en E.164 o nada. Esta invariante es de la que depende la
  -- deduplicación de la importación y el emparejamiento de WhatsApp.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'contact_phone_e164_format') THEN
    ALTER TABLE public.contact
      ADD CONSTRAINT contact_phone_e164_format
      CHECK (phone_e164 IS NULL OR phone_e164 ~ '^\+[1-9][0-9]{6,14}$');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'contact_whatsapp_e164_format') THEN
    ALTER TABLE public.contact
      ADD CONSTRAINT contact_whatsapp_e164_format
      CHECK (whatsapp_e164 IS NULL OR whatsapp_e164 ~ '^\+[1-9][0-9]{6,14}$');
  END IF;

  -- Una franja de disponibilidad debe ser un intervalo válido del día
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'availability_valid_range') THEN
    ALTER TABLE public.availability
      ADD CONSTRAINT availability_valid_range
      CHECK (weekday BETWEEN 0 AND 6 AND start_minute >= 0 AND end_minute <= 1440 AND end_minute > start_minute);
  END IF;
END
$$;

-- ============================================================================
--  8 · Numeración de documentos sin colisiones
-- ----------------------------------------------------------------------------
--  Dos facturas emitidas en el mismo milisegundo NO pueden compartir número.
--  Una secuencia de Postgres no sirve: el contador es por empresa, por tipo,
--  por serie y por año, y debe poder reiniciarse en enero.
--
--  La solución es un UPDATE ... RETURNING, que toma el bloqueo de fila de
--  forma atómica. El segundo llamante espera al primero y recibe el siguiente.
--  Se llama DENTRO de la transacción que emite el documento, así que si la
--  emisión falla, el número se devuelve.
-- ============================================================================
CREATE OR REPLACE FUNCTION next_document_number(
  p_tenant_id uuid,
  p_kind      text,
  p_series    text DEFAULT '001',
  p_year      int  DEFAULT NULL
)
RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
  v_year    int := coalesce(p_year, extract(year FROM now())::int);
  v_next    int;
  v_prefix  text;
  v_padding int;
BEGIN
  -- Crea la secuencia del año si es la primera emisión de enero.
  INSERT INTO public.number_sequence (tenant_id, kind, series, year, prefix, padding, current, updated_at)
  VALUES (
    p_tenant_id,
    p_kind::"DocumentKind",
    p_series,
    v_year,
    CASE p_kind
      WHEN 'INVOICE'     THEN 'FAC'
      WHEN 'QUOTE'       THEN 'COT'
      WHEN 'PROFORMA'    THEN 'PRO'
      WHEN 'CREDIT_NOTE' THEN 'NC'
      ELSE 'DOC'
    END,
    5, 0, now()
  )
  ON CONFLICT (tenant_id, kind, series, year) DO NOTHING;

  -- Incremento atómico. El bloqueo de fila lo toma el propio UPDATE.
  UPDATE public.number_sequence
     SET current = current + 1,
         updated_at = now()
   WHERE tenant_id = p_tenant_id
     AND kind      = p_kind::"DocumentKind"
     AND series    = p_series
     AND year      = v_year
  RETURNING current, prefix, padding
      INTO v_next, v_prefix, v_padding;

  IF v_next IS NULL THEN
    RAISE EXCEPTION 'No se pudo obtener la secuencia para % / % / % / %',
      p_tenant_id, p_kind, p_series, v_year;
  END IF;

  -- FAC-2026-00041
  RETURN format('%s-%s-%s', v_prefix, v_year, lpad(v_next::text, v_padding, '0'));
END;
$$;

COMMENT ON FUNCTION next_document_number(uuid, text, text, int) IS
  'Siguiente número de documento, atómico por empresa/tipo/serie/año. Llamar dentro de la transacción de emisión.';

-- ============================================================================
--  9 · Orden fraccional del Kanban
-- ----------------------------------------------------------------------------
--  Mover una tarjeta escribe UNA fila: se le asigna el punto medio entre sus
--  dos vecinas. Tras muchos movimientos en el mismo hueco, los flotantes se
--  agotan (~50 movimientos consecutivos entre las mismas dos tarjetas), y
--  entonces —y sólo entonces— se reequilibra la columna entera.
-- ============================================================================
CREATE OR REPLACE FUNCTION rebalance_stage_positions(p_tenant_id uuid, p_stage_id uuid)
RETURNS int
LANGUAGE plpgsql
AS $$
DECLARE
  n int;
BEGIN
  WITH ordered AS (
    SELECT id, row_number() OVER (ORDER BY position, created_at) AS rn
    FROM public.deal
    WHERE tenant_id = p_tenant_id
      AND stage_id  = p_stage_id
      AND deleted_at IS NULL
  )
  UPDATE public.deal d
     SET position = o.rn * 1000.0
    FROM ordered o
   WHERE d.id = o.id;

  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;

-- ============================================================================
--  10 · PARTICIONADO DE `message` — pendiente, y a propósito
-- ----------------------------------------------------------------------------
--  El plan de arquitectura preveía particionar `message` por mes desde el
--  inicio. Con Prisma no es posible: no puede crear una tabla PARTITION BY, y
--  convertirla después exige recrear y copiar.
--
--  Decisión: NO particionar ahora. A la escala de arranque (decenas de
--  empresas) los índices compuestos rinden de sobra, y particionar añade
--  operación —crear particiones futuras, vigilar que existan— que no compra
--  nada todavía.
--
--  El momento de hacerlo es cuando `message` pase de ~50 millones de filas o
--  los respaldos empiecen a doler. El procedimiento está escrito y probado en
--  infra/scripts/partition-messages.sql para no tener que improvisarlo bajo
--  presión. Requiere una ventana de mantenimiento.
-- ============================================================================

-- ============================================================================
--  11 · Estadísticas
-- ----------------------------------------------------------------------------
--  Estas columnas se consultan siempre juntas y están correlacionadas: el
--  planificador lo hace mucho mejor si se lo decimos.
-- ============================================================================
CREATE STATISTICS IF NOT EXISTS deal_stage_stats (dependencies)
  ON tenant_id, pipeline_id, stage_id FROM public.deal;

CREATE STATISTICS IF NOT EXISTS message_conv_stats (dependencies)
  ON tenant_id, conversation_id FROM public.message;

ANALYZE public.contact;
ANALYZE public.deal;
ANALYZE public.message;
