-- ============================================================================
--  Archivos: ciclo de vida, adjuntos de WhatsApp y referencias de la misma empresa
-- ----------------------------------------------------------------------------
--  1. `file.status` (PENDING → READY | REJECTED): un archivo sólo se firma para
--     descarga o se envía cuando está READY, es decir, comprobado. Los PENDING
--     antiguos son subidas abandonadas y los borrará la limpieza periódica.
--
--  2. Los archivos que YA existan pasan a READY: son anteriores a este ciclo
--     de vida, están completos, y sin esto la limpieza los tomaría por
--     abandonados y los borraría.
--
--  3. message_media → message y → file con claves foráneas COMPUESTAS
--     (tenant_id, id), como role_permission en 20260917000000. Una FK simple se
--     comprueba sin RLS, y un adjunto de una empresa podría colgar del archivo
--     de otra. Si alguna fila existente lo hiciera, esta migración FALLA a
--     propósito: sería un dato corrupto que hay que investigar, no ocultar.
--
--  4. La FK a `file` es ON DELETE NO ACTION y no SET NULL: con la clave
--     compuesta, SET NULL vaciaría también tenant_id (NOT NULL). Un archivo
--     enlazado no se borra suelto; al borrar la empresa se van los dos en la
--     misma sentencia, que es cuando NO ACTION comprueba.
-- ============================================================================

-- CreateEnum
CREATE TYPE "FileStatus" AS ENUM ('PENDING', 'READY', 'REJECTED');

-- AlterEnum
ALTER TYPE "FilePurpose" ADD VALUE 'WHATSAPP_MEDIA';

-- DropForeignKey
ALTER TABLE "message_media" DROP CONSTRAINT "message_media_file_id_fkey";

-- DropForeignKey
ALTER TABLE "message_media" DROP CONSTRAINT "message_media_message_id_fkey";

-- AlterTable
ALTER TABLE "file" ADD COLUMN     "ready_at" TIMESTAMPTZ(6),
ADD COLUMN     "reject_reason" VARCHAR(300),
ADD COLUMN     "status" "FileStatus" NOT NULL DEFAULT 'PENDING';

-- Lo anterior a este ciclo de vida ya estaba completo (punto 2 de la cabecera).
-- Se ejecuta como dueño de la tabla, igual que el relleno de 20260917000000.
UPDATE "file" SET "status" = 'READY', "ready_at" = "created_at";

-- CreateIndex
CREATE INDEX "file_status_created_at_idx" ON "file"("status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "file_tenant_id_id_key" ON "file"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "message_tenant_id_id_key" ON "message"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "message_media_tenant_id_file_id_idx" ON "message_media"("tenant_id", "file_id");

-- AddForeignKey
ALTER TABLE "message_media" ADD CONSTRAINT "message_media_tenant_id_message_id_fkey" FOREIGN KEY ("tenant_id", "message_id") REFERENCES "message"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message_media" ADD CONSTRAINT "message_media_tenant_id_file_id_fkey" FOREIGN KEY ("tenant_id", "file_id") REFERENCES "file"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;
