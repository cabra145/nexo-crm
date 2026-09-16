#!/usr/bin/env node
/**
 * Comprueba que no haya agujeros de aislamiento y devuelve código de salida
 * distinto de cero si los hay.
 *
 * Corre en CI y en el arranque de la API. Es la diferencia entre "creemos que
 * el aislamiento está bien" y "el despliegue no sale si no lo está".
 */
import pg from 'pg';

const DATABASE_URL = process.env.DIRECT_DATABASE_URL ?? process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('Falta DATABASE_URL.');
  process.exit(1);
}

const client = new pg.Client({ connectionString: DATABASE_URL });
await client.connect();

try {
  const { rows } = await client.query('SELECT table_name, problem FROM verify_tenant_isolation()');

  if (rows.length === 0) {
    const { rows: counted } = await client.query(`
      SELECT count(*)::int AS n
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_policy  p ON p.polrelid = c.oid
      WHERE n.nspname = 'public' AND c.relrowsecurity AND c.relforcerowsecurity
    `);
    console.log(
      `Aislamiento verificado: ${counted[0].n} políticas activas sobre tablas con RLS forzada.`,
    );
    process.exit(0);
  }

  console.error(`AISLAMIENTO INCOMPLETO — ${rows.length} problema(s):\n`);
  for (const row of rows) {
    console.error(`  · ${row.table_name} → ${row.problem}`);
  }
  console.error('\nEjecuta `pnpm db:rls` para aplicar las políticas que faltan.');
  process.exit(1);
} finally {
  await client.end();
}
