#!/usr/bin/env node
/**
 * Crea (o actualiza) el rol de aplicación `nexo_app` a partir de DATABASE_URL.
 *
 * En desarrollo lo hace el script de inicialización del contenedor
 * (infra/docker/postgres-init). Pero hay entornos donde no hay tal script: los
 * servicios de GitHub Actions, un Postgres gestionado, un VPS nuevo. Ahí se
 * ejecuta esto, conectando con el rol dueño (DIRECT_DATABASE_URL).
 *
 * El usuario y la contraseña se leen de DATABASE_URL, que es donde ya están:
 * no hay una segunda copia de la contraseña que pueda desincronizarse.
 *
 * Idempotente.
 */
import pg from 'pg';

const APP_URL = process.env.DATABASE_URL;
const OWNER_URL = process.env.DIRECT_DATABASE_URL;

if (!APP_URL || !OWNER_URL) {
  console.error('Faltan DATABASE_URL (rol de aplicación) y/o DIRECT_DATABASE_URL (rol dueño).');
  process.exit(1);
}

const app = new URL(APP_URL);
const role = decodeURIComponent(app.username);
const password = decodeURIComponent(app.password);
const database = app.pathname.replace(/^\//, '');

if (!role || !password) {
  console.error('DATABASE_URL debe incluir usuario y contraseña del rol de aplicación.');
  process.exit(1);
}

const owner = new URL(OWNER_URL);
owner.search = '';
if (decodeURIComponent(owner.username) === role) {
  console.error(
    'DATABASE_URL y DIRECT_DATABASE_URL usan el mismo usuario. La aplicación NO debe conectar ' +
      'con el rol dueño: con él, FORCE ROW LEVEL SECURITY no tendría efecto.',
  );
  process.exit(1);
}

const client = new pg.Client({ connectionString: owner.toString() });
await client.connect();

try {
  // CREATE ROLE no admite parámetros ($1), así que el SQL se compone en el
  // propio servidor con format(): %I cita identificadores y %L literales. La
  // contraseña nunca se concatena como texto en JavaScript.
  const { rows } = await client.query(
    `SELECT CASE
       WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1)
       THEN format('ALTER ROLE %I LOGIN PASSWORD %L NOBYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE', $1::text, $2::text)
       ELSE format('CREATE ROLE %I LOGIN PASSWORD %L NOBYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE', $1::text, $2::text)
     END AS sql,
     EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1) AS existed`,
    [role, password],
  );
  await client.query(rows[0].sql);

  const { rows: grant } = await client.query(
    `SELECT format('GRANT CONNECT ON DATABASE %I TO %I', $1::text, $2::text) AS sql`,
    [database, role],
  );
  await client.query(grant[0].sql);

  const { rows: schema } = await client.query(
    `SELECT format('GRANT USAGE ON SCHEMA public TO %I', $1::text) AS usage,
            format('REVOKE CREATE ON SCHEMA public FROM %I', $1::text) AS no_create`,
    [role],
  );
  await client.query(schema[0].usage);
  await client.query(schema[0].no_create);

  console.log(
    `Rol ${role} ${rows[0].existed ? 'actualizado' : 'creado'}: sin BYPASSRLS y sin permiso para alterar el esquema.`,
  );
} finally {
  await client.end();
}
