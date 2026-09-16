#!/usr/bin/env node
/**
 * Aplica los archivos de prisma/sql/ en orden.
 *
 * Existen aparte de las migraciones de Prisma porque contienen cosas que
 * Prisma no expresa —políticas RLS, triggers, índices GIN y HNSW, funciones—
 * y que además hay que REAPLICAR después de cada migración de esquema: una
 * tabla nueva necesita su política, y `prisma migrate` no la pondría.
 *
 * Por eso todos son idempotentes, y por eso `db:migrate` y `db:deploy` los
 * ejecutan siempre, no como paso opcional.
 *
 *   node scripts/apply-sql.mjs              → todos, en orden alfabético
 *   node scripts/apply-sql.mjs 01_rls.sql   → sólo uno
 *
 * Se usa `pg` y no `psql` para no tener que meter el cliente de PostgreSQL en
 * la imagen del contenedor de migraciones. Cada archivo se envía COMPLETO en
 * una sola consulta: el protocolo simple de Postgres admite varias sentencias,
 * y así los bloques `DO $$ ... $$` y los cuerpos de función entre dólares
 * llegan intactos. Trocear por `;` los rompería.
 */
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const here = dirname(fileURLToPath(import.meta.url));
const sqlDir = join(here, '..', 'prisma', 'sql');

const DATABASE_URL = process.env.DIRECT_DATABASE_URL ?? process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('Falta DATABASE_URL. Copia .env.example a .env antes de continuar.');
  process.exit(1);
}

async function main() {
  const requested = process.argv[2];
  const files = requested
    ? [requested]
    : (await readdir(sqlDir)).filter((f) => f.endsWith('.sql')).sort();

  if (files.length === 0) {
    console.log('No hay archivos SQL que aplicar.');
    return;
  }

  const client = new pg.Client({ connectionString: DATABASE_URL });

  // Los RAISE NOTICE de los scripts son su informe de ejecución —cuántas
  // políticas se aplicaron, si la verificación pasó—, así que se muestran.
  client.on('notice', (notice) => {
    if (notice.message) console.log(`      · ${notice.message}`);
  });

  await client.connect();

  try {
    console.log(`Aplicando ${files.length} archivo(s) SQL:`);

    for (const filename of files) {
      const sql = await readFile(join(sqlDir, filename), 'utf8');
      process.stdout.write(`  ${filename} … `);

      try {
        await client.query(sql);
        console.log('ok');
      } catch (error) {
        console.log('FALLÓ\n');
        console.error(`  ${error.message}`);
        if (error.hint) console.error(`  Pista: ${error.hint}`);
        if (error.position) console.error(`  Posición: ${error.position}`);
        console.error(
          `\nNo se aplicó ${filename}. Los archivos ya aplicados antes de éste sí ` +
            'quedaron; todos son idempotentes, así que corrige y vuelve a lanzar.',
        );
        process.exitCode = 1;
        return;
      }
    }

    console.log('Listo.');
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
