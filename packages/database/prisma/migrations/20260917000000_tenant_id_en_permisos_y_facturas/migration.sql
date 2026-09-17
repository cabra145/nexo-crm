-- ============================================================================
--  tenant_id en role_permission y subscription_invoice
-- ----------------------------------------------------------------------------
--  Las dos tablas guardaban datos de empresa sin columna tenant_id, así que
--  quedaban FUERA de la RLS: se llegaba a la empresa sólo a través de la tabla
--  padre (role, subscription), y una consulta directa veía las de todas.
--
--  Prisma genera `ADD COLUMN tenant_id UUID NOT NULL`, que FALLA en cualquier
--  base con filas: Postgres no puede inventar el valor. Por eso se hace en tres
--  tiempos: columna opcional → rellenarla desde la tabla padre → obligatoria.
--
--  Tras esta migración hay que volver a aplicar prisma/sql/01_rls.sql (lo hacen
--  `pnpm db:migrate` y `pnpm db:deploy`): el script detecta las dos tablas
--  nuevas con tenant_id y les pone su política sin tocar esta migración.
-- ============================================================================

-- --- Claves foráneas e índices que se reemplazan --------------------------------
ALTER TABLE "role_permission" DROP CONSTRAINT "role_permission_role_id_fkey";
ALTER TABLE "subscription_invoice" DROP CONSTRAINT "subscription_invoice_subscription_id_fkey";

-- (tenant_id) queda cubierto por el nuevo índice único (tenant_id, id).
DROP INDEX "role_tenant_id_idx";
-- (role_id) queda cubierto por la unicidad (role_id, permission).
DROP INDEX "role_permission_role_id_idx";

-- --- role_permission --------------------------------------------------------------
ALTER TABLE "role_permission" ADD COLUMN "tenant_id" UUID;

-- Se rellena como dueño de la tabla (con el que corren las migraciones).
UPDATE "role_permission" rp
   SET "tenant_id" = r."tenant_id"
  FROM "role" r
 WHERE r."id" = rp."role_id";

ALTER TABLE "role_permission" ALTER COLUMN "tenant_id" SET NOT NULL;

-- --- subscription_invoice ---------------------------------------------------------
ALTER TABLE "subscription_invoice" ADD COLUMN "tenant_id" UUID;

UPDATE "subscription_invoice" si
   SET "tenant_id" = s."tenant_id"
  FROM "subscription" s
 WHERE s."id" = si."subscription_id";

ALTER TABLE "subscription_invoice" ALTER COLUMN "tenant_id" SET NOT NULL;

-- --- Índices ----------------------------------------------------------------------
-- Destinos de las claves foráneas compuestas.
CREATE UNIQUE INDEX "role_tenant_id_id_key" ON "role"("tenant_id", "id");
CREATE UNIQUE INDEX "subscription_tenant_id_id_key" ON "subscription"("tenant_id", "id");

CREATE INDEX "role_permission_tenant_id_role_id_idx" ON "role_permission"("tenant_id", "role_id");
CREATE INDEX "subscription_invoice_tenant_id_created_at_idx" ON "subscription_invoice"("tenant_id", "created_at" DESC);

-- --- Claves foráneas COMPUESTAS ---------------------------------------------------
-- No basta con que el rol o la suscripción existan: tienen que ser de la MISMA
-- empresa que la fila hija. Una fila con el tenant_id de una empresa colgando
-- del rol de otra es, desde aquí, imposible.
ALTER TABLE "role_permission"
  ADD CONSTRAINT "role_permission_tenant_id_role_id_fkey"
  FOREIGN KEY ("tenant_id", "role_id") REFERENCES "role"("tenant_id", "id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "subscription_invoice"
  ADD CONSTRAINT "subscription_invoice_tenant_id_subscription_id_fkey"
  FOREIGN KEY ("tenant_id", "subscription_id") REFERENCES "subscription"("tenant_id", "id")
  ON DELETE CASCADE ON UPDATE CASCADE;
