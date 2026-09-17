#!/usr/bin/env node
/**
 * Genera una migración nueva a partir de los cambios en schema.prisma.
 *
 *   pnpm db:migration:new <nombre_en_snake_case>
 *
 * Sustituye a `prisma migrate dev`, que en este proyecto NO se debe usar.
 *
 * ---------------------------------------------------------------------------
 * Por qué no `prisma migrate dev`
 *
 * `migrate dev` compara la base de datos REAL con el historial de migraciones.
 * Nuestra base tiene objetos que schema.prisma no puede declarar —índices GIN
 * de búsqueda, trigram y jsonb, y el índice HNSW de pgvector, creados por
 * prisma/sql/02_search_and_indexes.sql—, así que Prisma los ve como una
 * "desviación" y OFRECE REINICIAR LA BASE DE DATOS, borrando todos los datos.
 *
 * Este script compara el HISTORIAL DE MIGRACIONES con schema.prisma sobre una
 * base auxiliar desechable (<base>_shadow). La base real no interviene, así que
 * los índices de SQL no molestan y nunca se propone reiniciar nada.
 *
 * Para APLICAR migraciones: `pnpm db:migrate` (migrate deploy + scripts SQL).
 * ---------------------------------------------------------------------------
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, '..');
const migrationsDir = join(pkgRoot, 'prisma', 'migrations');
const schemaPath = join(pkgRoot, 'prisma', 'schema.prisma');
const prismaCli = join(pkgRoot, 'node_modules', 'prisma', 'build', 'index.js');

const name = process.argv[2];
if (!name || !/^[a-z0-9]+(_[a-z0-9]+)*$/.test(name)) {
  console.error(
    'Uso: pnpm db:migration:new <nombre_en_snake_case>\n' +
      'Ejemplo: pnpm db:migration:new campo_origen_en_contactos',
  );
  process.exit(1);
}

const ownerUrl = process.env.DIRECT_DATABASE_URL;
if (!ownerUrl) {
  console.error('Falta DIRECT_DATABASE_URL (rol dueño): hace falta para crear la base auxiliar.');
  process.exit(1);
}

// --- Base auxiliar: la misma instancia, otra base de datos --------------------
const owner = new URL(ownerUrl);
owner.search = '';
const database = owner.pathname.replace(/^\//, '');
const shadowName = `${database}_shadow`;
const shadow = new URL(owner.toString());
shadow.pathname = `/${shadowName}`;

const client = new pg.Client({ connectionString: owner.toString() });
await client.connect();
try {
  const { rowCount } = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [
    shadowName,
  ]);
  if (rowCount === 0) {
    const { rows } = await client.query(`SELECT format('CREATE DATABASE %I', $1::text) AS sql`, [
      shadowName,
    ]);
    await client.query(rows[0].sql);
    console.log(`Base auxiliar ${shadowName} creada.`);
  }
} finally {
  await client.end();
}

// --- Diferencia entre el historial de migraciones y el esquema ---------------
const result = spawnSync(
  process.execPath,
  [
    prismaCli,
    'migrate',
    'diff',
    '--from-migrations',
    migrationsDir,
    '--to-schema-datamodel',
    schemaPath,
    '--shadow-database-url',
    shadow.toString(),
    '--script',
  ],
  { encoding: 'utf8', cwd: pkgRoot },
);

if (result.status !== 0) {
  console.error('prisma migrate diff falló:\n');
  console.error(result.stderr || result.stdout);
  process.exit(1);
}

// `migrate diff --from-migrations` propone siempre crear las cuatro extensiones,
// aunque la migración 20260101000000_init_extensions ya las crea: al comparar
// contra un historial no las reconoce como suyas. Son `IF NOT EXISTS` y no
// cambian nada, pero ensuciarían cada migración nueva, así que se quitan.
const sql = result.stdout
  .replace(/-- CreateExtension\nCREATE EXTENSION IF NOT EXISTS "[a-z_0-9]+";\n*/g, '')
  .trim();

const meaningful = sql.split('\n').filter((line) => line.trim() && !line.trim().startsWith('--'));

if (meaningful.length === 0) {
  console.log('schema.prisma ya coincide con las migraciones: no hay nada que generar.');
  process.exit(0);
}

// --- Escribir la migración ------------------------------------------------------
const now = new Date();
const pad = (n) => String(n).padStart(2, '0');
const stamp =
  `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}` +
  `${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`;

const last = readdirSync(migrationsDir)
  .filter((d) => /^\d{14}_/.test(d))
  .sort()
  .at(-1);
if (last && `${stamp}_${name}` <= last) {
  console.error(
    `La marca de tiempo ${stamp} no es posterior a la última migración (${last}). ` +
      'Las migraciones se aplican por orden alfabético: revisa el reloj del sistema.',
  );
  process.exit(1);
}

const folder = join(migrationsDir, `${stamp}_${name}`);
if (existsSync(folder)) {
  console.error(`Ya existe ${folder}.`);
  process.exit(1);
}
mkdirSync(folder, { recursive: true });
const file = join(folder, 'migration.sql');
writeFileSync(file, `${sql}\n`);

console.log(`Migración generada: ${relative(process.cwd(), file)}\n`);

// --- Avisos sobre SQL que suele fallar o destruir datos ------------------------
const warnings = [];
if (/ADD COLUMN\s+"[^"]+"\s+[^,;]*NOT NULL(?![^,;]*DEFAULT)/i.test(sql)) {
  warnings.push(
    'Añade una columna NOT NULL sin valor por defecto: FALLARÁ en cualquier tabla con filas.\n' +
      '    Reescríbela en tres pasos: columna opcional → rellenarla (UPDATE) → SET NOT NULL.\n' +
      '    Ejemplo: prisma/migrations/20260917000000_tenant_id_en_permisos_y_facturas',
  );
}
if (/DROP (TABLE|COLUMN)/i.test(sql)) {
  warnings.push('Elimina tablas o columnas: los datos que contengan se pierden.');
}
if (/ALTER COLUMN\s+"[^"]+"\s+SET DATA TYPE/i.test(sql)) {
  warnings.push('Cambia el tipo de una columna: puede fallar o truncar datos existentes.');
}
if (/CREATE TABLE/i.test(sql)) {
  warnings.push(
    'Crea tablas: si llevan tenant_id, `pnpm db:migrate` les aplicará RLS automáticamente.\n' +
      '    Si guardan datos de empresa y NO llevan tenant_id, la verificación de aislamiento fallará.',
  );
}

if (warnings.length) {
  console.log('Revisa antes de aplicar:');
  for (const w of warnings) console.log(`  · ${w}`);
  console.log();
}

console.log('Cuando la hayas revisado, aplícala con: pnpm db:migrate');
