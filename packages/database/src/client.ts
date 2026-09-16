import { AsyncLocalStorage } from 'node:async_hooks';
import { Prisma, PrismaClient } from '@prisma/client';
import { getTenantContext, requireTenantId } from './tenant-context';

/* ============================================================================
 *  CAPA 2 DEL AISLAMIENTO · Ámbito automático de empresa en Prisma
 * ----------------------------------------------------------------------------
 *  Este archivo hace dos cosas, y las dos son independientes entre sí:
 *
 *    A) Fija `app.tenant_id` en cada transacción, que es lo que activan las
 *       políticas RLS de Postgres (capa 3, la que de verdad no se puede saltar).
 *
 *    B) Inyecta `tenantId` en los `where` y los `data` de toda consulta a un
 *       modelo con ámbito de empresa.
 *
 *  ¿Por qué las dos, si (A) ya sería suficiente para la seguridad?
 *
 *  Porque sin (B), una consulta que olvide el filtro devolvería cero filas en
 *  vez de datos ajenos —seguro, sí— pero el bug se descubriría en producción
 *  como "no aparecen mis contactos". Con (B) el filtro está siempre, y (A) es
 *  la red por si (B) falla. Seguridad de (A), corrección de (B).
 * ========================================================================== */

/**
 * Modelos con ámbito de empresa, derivados del propio esquema en tiempo de
 * arranque leyendo el DMMF de Prisma.
 *
 * Esto NO es una lista mantenida a mano a propósito: añadir un modelo con
 * `tenantId` al schema.prisma basta para que quede protegido. No hay ningún
 * sitio donde olvidarse de registrarlo.
 */
const TENANT_SCOPED_MODELS: ReadonlySet<string> = new Set(
  Prisma.dmmf.datamodel.models
    .filter((model) =>
      model.fields.some((field) => field.name === 'tenantId' && field.isRequired && !field.isList),
    )
    .map((model) => model.name),
);

/**
 * Modelos que tienen `tenantId` pero NULABLE: se escriben antes de saber a qué
 * empresa pertenecen (una sesión antes de elegir espacio de trabajo, un
 * webhook de Meta antes de resolverlo). Su filtrado es explícito en el
 * servicio correspondiente y está cubierto por pruebas propias.
 *
 * Se listan aquí para que quede constancia de que la omisión es deliberada.
 */
const INTENTIONALLY_UNSCOPED = new Set(['RefreshToken', 'WebhookEvent']);

/**
 * Operaciones que aceptan `where`, y a las que por tanto se les inyecta el
 * filtro de empresa.
 *
 * `findUnique` está aquí a propósito: desde Prisma 5 el `where` de una
 * operación "unique" admite campos NO únicos adicionales mientras haya al
 * menos una restricción única satisfecha. Así que `{ id, tenantId }` es
 * válido, y un `findUnique` por PK de otra empresa devuelve null en vez de la
 * fila. Sin esto habría que degradarlo a `findFirst`.
 */
const WHERE_OPS = new Set([
  'findUnique',
  'findUniqueOrThrow',
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'count',
  'aggregate',
  'groupBy',
  'update',
  'updateMany',
  'delete',
  'deleteMany',
]);

/**
 * Marca que ya estamos dentro de una transacción con `app.tenant_id` fijado.
 * Sin esto, cada consulta dentro de una transacción interactiva abriría otra
 * transacción anidada.
 */
const insideTenantTransaction = new AsyncLocalStorage<true>();

function assertSchemaIsCovered(): void {
  const withNullableTenant = Prisma.dmmf.datamodel.models.filter((model) =>
    model.fields.some((field) => field.name === 'tenantId' && !field.isRequired && !field.isList),
  );

  const unexpected = withNullableTenant
    .map((m) => m.name)
    .filter((name) => !INTENTIONALLY_UNSCOPED.has(name));

  if (unexpected.length > 0) {
    throw new Error(
      `Modelos con \`tenantId\` NULABLE que nadie declaró como excepción: ${unexpected.join(', ')}.\n` +
        'Un tenantId nulable no queda cubierto por RLS ni por el ámbito automático.\n' +
        'Haz el campo obligatorio, o añádelo a INTENTIONALLY_UNSCOPED explicando por qué,\n' +
        'y añádelo también a _rls_excluded_tables() en prisma/sql/01_rls.sql.',
    );
  }
}

assertSchemaIsCovered();

/* ------------------------------------------------------------------------- */

function createBaseClient(): PrismaClient {
  return new PrismaClient({
    log:
      process.env.NODE_ENV === 'development'
        ? [
            { emit: 'event', level: 'query' },
            { emit: 'stdout', level: 'warn' },
            { emit: 'stdout', level: 'error' },
          ]
        : [
            { emit: 'stdout', level: 'warn' },
            { emit: 'stdout', level: 'error' },
          ],
  });
}

/**
 * Cliente sin ámbito de empresa.
 *
 * Úsalo SÓLO para: autenticación (antes de saber la empresa), el panel de
 * plataforma, migraciones y trabajos de mantenimiento. Cualquier otro uso es
 * un agujero de aislamiento esperando a ocurrir.
 *
 * Nota: aunque este cliente no filtre por aplicación, sigue conectando con el
 * rol `nexo_app`, que NO tiene BYPASSRLS. Si `app.tenant_id` no está fijado,
 * las tablas con política devuelven cero filas.
 */
export const platformPrisma = createBaseClient();

/**
 * Cliente de negocio. Toda consulta a un modelo con ámbito de empresa:
 *
 *   1. exige que haya contexto de empresa,
 *   2. corre dentro de una transacción con `app.tenant_id` fijado,
 *   3. lleva `tenantId` inyectado en su `where` o su `data`.
 */
export const prisma = platformPrisma.$extends({
  name: 'tenant-isolation',
  query: {
    $allModels: {
      async $allOperations({ model, operation, args, query }) {
        if (!TENANT_SCOPED_MODELS.has(model)) {
          return query(args);
        }

        const context = getTenantContext();
        if (!context?.tenantId) {
          throw new Error(
            `Consulta a ${model}.${operation} sin contexto de empresa.\n` +
              'Envuélvela en runWithTenantContext(), o usa platformPrisma si de ' +
              'verdad es una operación de plataforma.',
          );
        }

        const tenantId = context.tenantId;

        // Los argumentos de esta función son la unión de los de TODOS los
        // modelos y operaciones, así que no hay un tipo concreto que los
        // describa. Se tratan como objetos genéricos: lo único que se hace es
        // añadir `tenantId` en el sitio correcto, sin leer nada más.
        type Args = Record<string, unknown>;
        const input = (args ?? {}) as Args;
        const asArgs = (value: unknown): Args =>
          value !== null && typeof value === 'object' ? (value as Args) : {};

        let nextArgs: Args = input;

        if (WHERE_OPS.has(operation)) {
          nextArgs = { ...input, where: { ...asArgs(input.where), tenantId } };
        } else if (operation === 'create') {
          nextArgs = { ...input, data: { ...asArgs(input.data), tenantId } };
        } else if (operation === 'createMany' || operation === 'createManyAndReturn') {
          const rows: unknown[] = Array.isArray(input.data) ? input.data : [input.data];
          nextArgs = { ...input, data: rows.map((row) => ({ ...asArgs(row), tenantId })) };
        } else if (operation === 'upsert') {
          nextArgs = {
            ...input,
            where: { ...asArgs(input.where), tenantId },
            create: { ...asArgs(input.create), tenantId },
            update: asArgs(input.update),
          };
        }

        const finalArgs = nextArgs as typeof args;

        // Ya estamos dentro de una transacción que fijó `app.tenant_id` una
        // sola vez. Abrir otra aquí la anidaría sin necesidad.
        if (insideTenantTransaction.getStore()) {
          return query(finalArgs);
        }

        // --- Una transacción por consulta ----------------------------------
        // `set_config(..., true)` es LOCAL a la transacción: se deshace al
        // terminar, así que una conexión reutilizada del pool nunca hereda la
        // empresa de la petición anterior. Es exactamente la garantía que
        // necesitamos con un pool compartido entre clientes.
        // `query()` devuelve una PrismaPromise, que es lo que acepta la forma en
        // lote de `$transaction`; sus tipos sólo la declaran como Promise.
        const [, result] = await platformPrisma.$transaction([
          platformPrisma.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}::text, true)`,
          query(finalArgs) as Prisma.PrismaPromise<unknown>,
        ]);

        return result;
      },
    },
  },
});

export type TenantPrismaClient = typeof prisma;

/**
 * El cliente que se recibe dentro de `runInTenantTransaction`. Conserva las
 * extensiones —y por tanto el ámbito automático de empresa— porque nace del
 * `$transaction` del cliente extendido, no del base.
 */
export type TenantTransactionClient = Omit<
  TenantPrismaClient,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$extends'
>;

/**
 * Ejecuta varias operaciones en UNA sola transacción con el contexto de
 * empresa fijado una vez.
 *
 * Úsalo siempre que un cambio deba ser atómico —emitir una factura y avanzar
 * su secuencia, mover un trato y registrar su historial de etapa— y también
 * cuando hagas muchas escrituras seguidas: evita abrir una transacción por
 * consulta.
 *
 * @example
 * await runInTenantTransaction(async (tx) => {
 *   const number = await nextDocumentNumber(tx, 'INVOICE');
 *   return tx.document.create({ data: { number, ... } });
 * });
 */
export async function runInTenantTransaction<T>(
  fn: (tx: TenantTransactionClient) => Promise<T>,
  options?: { timeout?: number; isolationLevel?: Prisma.TransactionIsolationLevel },
): Promise<T> {
  const tenantId = requireTenantId();

  // Sobre el cliente EXTENDIDO, no sobre el base: así el `tx` que recibe `fn`
  // conserva el ámbito automático de empresa. Con `platformPrisma.$transaction`
  // las extensiones no se aplicarían dentro y cada consulta de la transacción
  // quedaría sin filtro de aplicación (la RLS aún la cubriría, pero devolvería
  // cero filas en vez de las correctas).
  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}::text, true)`;
      return insideTenantTransaction.run(true, () => fn(tx as TenantTransactionClient));
    },
    {
      timeout: options?.timeout ?? 15_000,
      isolationLevel: options?.isolationLevel,
    },
  );
}

/**
 * Comprueba contra la base de datos que el aislamiento sigue intacto.
 *
 * Llamado al arrancar la API y desde CI. Devuelve la lista de problemas; si
 * está vacía, todo está cubierto. La consulta la resuelve `verify_tenant_isolation()`,
 * definida en prisma/sql/01_rls.sql.
 */
export async function verifyTenantIsolation(): Promise<
  Array<{ table_name: string; problem: string }>
> {
  return platformPrisma.$queryRaw<Array<{ table_name: string; problem: string }>>`
    SELECT table_name, problem FROM verify_tenant_isolation()
  `;
}

/** Modelos protegidos. Expuesto para las pruebas de aislamiento. */
export function getTenantScopedModels(): ReadonlySet<string> {
  return TENANT_SCOPED_MODELS;
}

/** Cierre ordenado: se llama desde el hook de apagado de la API y del worker. */
export async function disconnectDatabase(): Promise<void> {
  await platformPrisma.$disconnect();
}
