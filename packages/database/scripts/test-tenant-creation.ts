/**
 * Alta de empresa a través de Prisma, con el rol de aplicación.
 *
 * La prueba de aislamiento comprueba la política con SQL a mano. Ésta recorre
 * el camino REAL que usará el registro: `runInNewTenantTransaction` y el
 * cliente de Prisma, cuyo `INSERT … RETURNING` era lo que fallaba con la
 * política anterior.
 *
 * Crea una empresa con su rol y un permiso, comprueba que quedan aislados y la
 * borra al terminar.
 *
 *   pnpm --filter @nexo/database test:tenant-creation
 */
import {
  PrismaClient,
  disconnectDatabase,
  prisma,
  runInNewTenantTransaction,
  runWithTenantContext,
} from '../src/index';

const results: Array<{ name: string; passed: boolean }> = [];
function check(name: string, passed: boolean, detail = ''): void {
  results.push({ name, passed });
  console.log(`  ${passed ? '✓' : '✗'} ${name}${detail ? `  — ${detail}` : ''}`);
}

async function main(): Promise<void> {
  const owner = new PrismaClient({ datasourceUrl: process.env.DIRECT_DATABASE_URL });
  const slug = `alta-${Date.now().toString(36)}`;
  let createdId: string | null = null;

  console.log('\nAlta de empresa con Prisma y el rol de aplicación\n');

  try {
    const created = await runInNewTenantTransaction(async (tx, tenantId) => {
      const tenant = await tx.tenant.create({
        data: { id: tenantId, slug, name: 'Empresa de prueba de alta' },
      });
      const role = await tx.role.create({
        data: { tenantId, key: 'OWNER', name: 'Propietario', isSystem: true },
      });
      await tx.rolePermission.create({
        data: { tenantId, roleId: role.id, permission: 'contact:read', scope: 'ALL' },
      });
      return { tenant, role };
    });
    createdId = created.tenant.id;

    check('la empresa se crea sin ningún rol privilegiado', created.tenant.slug === slug);
    check('el rol queda en la empresa nueva', created.role.tenantId === createdId);

    const permission = await runWithTenantContext({ tenantId: createdId }, () =>
      prisma.rolePermission.findFirst({ where: { roleId: created.role.id } }),
    );
    check('el permiso se guarda con el tenant_id de su rol', permission?.tenantId === createdId);

    const acme = await owner.tenant.findUnique({ where: { slug: 'acme' } });
    if (!acme) throw new Error('Falta la empresa acme del seed');

    const seenFromAcme = await runWithTenantContext({ tenantId: acme.id }, () =>
      prisma.rolePermission.findMany({ where: { roleId: created.role.id } }),
    );
    check('Acme NO ve los permisos de la empresa nueva', seenFromAcme.length === 0);

    const tenantFromAcme = await runWithTenantContext({ tenantId: acme.id }, () =>
      prisma.tenant.findUnique({ where: { id: createdId! } }),
    );
    check('Acme NO ve la empresa nueva', tenantFromAcme === null);

    // Clave foránea compuesta: un permiso con el tenant_id de Acme colgando del
    // rol de la empresa nueva tiene que ser imposible, incluso para el dueño.
    let crossRejected = false;
    try {
      await owner.rolePermission.create({
        data: { tenantId: acme.id, roleId: created.role.id, permission: 'deal:read', scope: 'ALL' },
      });
    } catch {
      crossRejected = true;
    }
    check('la clave foránea compuesta impide mezclar empresas, incluso al dueño', crossRejected);
  } finally {
    if (createdId) await owner.tenant.delete({ where: { id: createdId } }).catch(() => {});
    await owner.$disconnect();
    await disconnectDatabase();
  }

  const failed = results.filter((r) => !r.passed).length;
  console.log(`\n${results.length - failed}/${results.length} comprobaciones superadas`);
  if (failed) process.exitCode = 1;
}

main()
  .catch((error: unknown) => {
    console.error('\nLa prueba no pudo completarse:\n', error);
    process.exitCode = 1;
  })
  .finally(() => process.exit(process.exitCode ?? 0));
