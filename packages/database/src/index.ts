/**
 * @nexo/database — acceso a datos con aislamiento por empresa.
 *
 * Regla de uso, en una línea:
 *   `prisma`         para datos de negocio (exige contexto de empresa)
 *   `platformPrisma` sólo para auth, panel de plataforma y mantenimiento
 */
export {
  prisma,
  platformPrisma,
  runInTenantTransaction,
  runInNewTenantTransaction,
  runAsAuthenticatedUser,
  runAsWebhookChannel,
  verifyTenantIsolation,
  getTenantScopedModels,
  disconnectDatabase,
  type TenantPrismaClient,
  type TenantTransactionClient,
} from './client';

export {
  runWithTenantContext,
  getTenantContext,
  requireTenantContext,
  requireTenantId,
  deriveContext,
  type TenantContext,
} from './tenant-context';

// PrismaClient como VALOR, no sólo como tipo: un `export { type PrismaClient }`
// explícito taparía el que trae el `export *` de abajo, y no se podría
// instanciar un cliente con otra conexión (lo necesitan el seed y las pruebas).
export { Prisma, PrismaClient } from '@prisma/client';

// Enums y tipos de modelo generados: los consumen los DTO de la API y los
// componentes de la web, de modo que un cambio de esquema rompe la compilación
// en vez de romperse en ejecución.
export * from '@prisma/client';
