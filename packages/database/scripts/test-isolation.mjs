#!/usr/bin/env node
/**
 * Prueba de aislamiento entre empresas, contra la base de datos real.
 *
 * `verify-rls` comprueba que las políticas EXISTEN. Esta prueba comprueba que
 * FUNCIONAN: se conecta con el mismo rol que usa la API (`nexo_app`) e intenta
 * de verdad leer, modificar e insertar datos de otra empresa.
 *
 * Necesita la base migrada, con los scripts SQL aplicados y el seed cargado
 * (usa las empresas `acme` y `boreal`). Todo lo que escribe se deshace con
 * ROLLBACK: no deja rastro.
 *
 *   pnpm --filter @nexo/database test:isolation
 *
 * Termina con código 1 si falla cualquier comprobación.
 */
import pg from 'pg';

const APP_URL = process.env.DATABASE_URL;
const OWNER_URL = process.env.DIRECT_DATABASE_URL;

if (!APP_URL || !OWNER_URL) {
  console.error('Faltan DATABASE_URL y/o DIRECT_DATABASE_URL.');
  process.exit(1);
}

/** `pg` no entiende los parámetros propios de Prisma (?schema=, ?connection_limit=). */
function clean(url) {
  const u = new URL(url);
  u.search = '';
  return u.toString();
}

const results = [];

function check(name, passed, detail = '') {
  results.push({ name, passed, detail });
  const mark = passed ? '✓' : '✗';
  console.log(`  ${mark} ${name}${detail ? `  — ${detail}` : ''}`);
}

/**
 * Espera que `fn` sea rechazado POR LA POLÍTICA RLS.
 *
 * No basta con que falle: un INSERT con una columna mal escrita también
 * fallaría, y la prueba pasaría sin que la RLS hubiera intervenido. Sólo cuenta
 * un error de "row-level security"; cualquier otro error es un fallo de la
 * prueba, no un éxito.
 */
async function expectRejected(client, name, fn) {
  await client.query('SAVEPOINT intento');
  try {
    await fn();
    await client.query('ROLLBACK TO SAVEPOINT intento');
    check(name, false, 'la base lo PERMITIÓ');
  } catch (error) {
    await client.query('ROLLBACK TO SAVEPOINT intento');
    const byRls = /row-level security/i.test(error.message);
    check(
      name,
      byRls,
      byRls
        ? 'rechazado por la política RLS'
        : `falló por OTRO motivo, así que no prueba nada: ${error.message.split('\n')[0]}`,
    );
  }
}

/** Ejecuta `fn` y espera que funcione; deshace lo que haga. */
async function expectAllowed(client, name, fn) {
  await client.query('SAVEPOINT control');
  try {
    await fn();
    check(name, true);
  } catch (error) {
    check(name, false, error.message.split('\n')[0]);
  } finally {
    await client.query('ROLLBACK TO SAVEPOINT control');
  }
}

async function withTenant(client, tenantId, fn) {
  await client.query('BEGIN');
  try {
    await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
    return await fn();
  } finally {
    await client.query('ROLLBACK');
  }
}

async function count(client, sql, params = []) {
  const { rows } = await client.query(sql, params);
  return Number(rows[0].n);
}

async function main() {
  // --- Preparación con el rol dueño: sólo para averiguar los ids -----------
  const owner = new pg.Client({ connectionString: clean(OWNER_URL) });
  await owner.connect();

  const { rows: tenants } = await owner.query(
    `SELECT slug, id FROM tenant WHERE slug IN ('acme', 'boreal')`,
  );
  const acme = tenants.find((t) => t.slug === 'acme')?.id;
  const boreal = tenants.find((t) => t.slug === 'boreal')?.id;

  if (!acme || !boreal) {
    console.error('No están las empresas `acme` y `boreal`. Ejecuta primero el seed.');
    await owner.end();
    process.exit(1);
  }

  const { rows: people } = await owner.query(
    `SELECT email, id FROM "user" WHERE email IN ('lucia@acme.test', 'owner@boreal.test')`,
  );
  const lucia = people.find((u) => u.email === 'lucia@acme.test')?.id;
  const borealOwner = people.find((u) => u.email === 'owner@boreal.test')?.id;
  const acmeMemberships = Number(
    (await owner.query('SELECT count(*) n FROM membership WHERE tenant_id = $1', [acme])).rows[0].n,
  );

  const expected = {
    acmeContacts: await count(owner, `SELECT count(*) n FROM contact WHERE tenant_id = $1`, [acme]),
    borealContacts: await count(owner, `SELECT count(*) n FROM contact WHERE tenant_id = $1`, [
      boreal,
    ]),
  };

  const { rows: scopedTables } = await owner.query(`
    SELECT c.relname AS name
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid
    WHERE n.nspname = 'public' AND c.relkind IN ('r','p')
      AND a.attname = 'tenant_id' AND a.attnotnull AND NOT a.attisdropped
      AND c.relname <> ALL (_rls_excluded_tables())
    ORDER BY c.relname
  `);
  await owner.end();

  // --- Todo lo demás, con el rol de la aplicación --------------------------
  const app = new pg.Client({ connectionString: clean(APP_URL) });
  await app.connect();

  console.log('\n1 · Identidad de la conexión');
  const { rows: who } = await app.query(`
    SELECT current_user AS usr, r.rolsuper, r.rolbypassrls
    FROM pg_roles r WHERE r.rolname = current_user
  `);
  check('conecta como nexo_app', who[0].usr === 'nexo_app', `usuario: ${who[0].usr}`);
  check('no es superusuario', who[0].rolsuper === false);
  check('no tiene BYPASSRLS', who[0].rolbypassrls === false);

  console.log('\n2 · Sin contexto de empresa no se ve nada');
  check(
    'contact sin contexto → 0 filas',
    (await count(app, `SELECT count(*) n FROM contact`)) === 0,
  );
  check('tenant sin contexto → 0 filas', (await count(app, `SELECT count(*) n FROM tenant`)) === 0);
  check('deal sin contexto → 0 filas', (await count(app, `SELECT count(*) n FROM deal`)) === 0);

  console.log('\n3 · Cada empresa ve exactamente lo suyo');
  await withTenant(app, acme, async () => {
    const n = await count(app, `SELECT count(*) n FROM contact`);
    check(`Acme ve sus ${expected.acmeContacts} contactos`, n === expected.acmeContacts, `ve ${n}`);
    const foreign = await count(app, `SELECT count(*) n FROM contact WHERE tenant_id = $1`, [
      boreal,
    ]);
    check('Acme pidiendo explícitamente los de Boreal → 0', foreign === 0, `ve ${foreign}`);
    const tenantsSeen = await count(app, `SELECT count(*) n FROM tenant`);
    check('Acme sólo ve su propia fila en tenant', tenantsSeen === 1, `ve ${tenantsSeen}`);
  });
  await withTenant(app, boreal, async () => {
    const n = await count(app, `SELECT count(*) n FROM contact`);
    check(
      `Boreal ve sus ${expected.borealContacts} contactos`,
      n === expected.borealContacts,
      `ve ${n}`,
    );
  });

  console.log(`\n4 · Barrido de las ${scopedTables.length} tablas protegidas desde Acme`);
  await withTenant(app, acme, async () => {
    const leaks = [];
    for (const { name } of scopedTables) {
      const n = await count(app, `SELECT count(*) n FROM public."${name}" WHERE tenant_id <> $1`, [
        acme,
      ]);
      if (n > 0) leaks.push(`${name} (${n})`);
    }
    check(
      `ninguna de las ${scopedTables.length} tablas muestra filas de otra empresa`,
      leaks.length === 0,
      leaks.length ? `FUGAS: ${leaks.join(', ')}` : '',
    );
  });

  console.log('\n5 · Intentos de escritura sobre otra empresa (deben fallar o no afectar a nada)');
  await withTenant(app, acme, async () => {
    // Control: el MISMO insert, con la empresa correcta, tiene que funcionar.
    // Si no, un rechazo posterior no demostraría nada sobre la RLS.
    await expectAllowed(app, 'control: insertar un contacto en Acme SÍ funciona', () =>
      app.query(
        `INSERT INTO contact (tenant_id, first_name, lifecycle_stage, custom, updated_at)
         VALUES ($1, 'Control', 'LEAD', '{}', now())`,
        [acme],
      ),
    );

    await expectRejected(app, 'insertar un contacto con tenant_id de Boreal', () =>
      app.query(
        `INSERT INTO contact (tenant_id, first_name, lifecycle_stage, custom, updated_at)
         VALUES ($1, 'Intruso', 'LEAD', '{}', now())`,
        [boreal],
      ),
    );

    await expectRejected(app, 'mover un contacto propio a Boreal (UPDATE tenant_id)', async () => {
      const { rowCount } = await app.query(
        `UPDATE contact SET tenant_id = $1
         WHERE id = (SELECT id FROM contact LIMIT 1)`,
        [boreal],
      );
      if (rowCount === 0) throw new Error('ninguna fila afectada');
    });

    const { rowCount: updated } = await app.query(
      `UPDATE contact SET first_name = 'Modificado' WHERE tenant_id = $1`,
      [boreal],
    );
    check(
      'modificar contactos de Boreal → 0 filas afectadas',
      updated === 0,
      `${updated} afectadas`,
    );

    const { rowCount: deleted } = await app.query(`DELETE FROM deal WHERE tenant_id = $1`, [
      boreal,
    ]);
    check(
      'borrar oportunidades de Boreal → 0 filas afectadas',
      deleted === 0,
      `${deleted} afectadas`,
    );

    const { rowCount: tenantUpdated } = await app.query(
      `UPDATE tenant SET name = 'Secuestrada' WHERE id = $1`,
      [boreal],
    );
    check('renombrar la empresa Boreal → 0 filas afectadas', tenantUpdated === 0);
  });

  console.log('\n6 · El contexto no se hereda entre transacciones (conexión reutilizada)');
  await withTenant(app, acme, async () => {
    await count(app, `SELECT count(*) n FROM contact`);
  });
  check(
    'tras terminar la transacción de Acme, la misma conexión ya no ve nada',
    (await count(app, `SELECT count(*) n FROM contact`)) === 0,
  );

  console.log('\n7 · Un contexto inválido no abre la puerta');
  await app.query('BEGIN');
  await app.query(`SELECT set_config('app.tenant_id', '', true)`);
  check('contexto vacío → 0 filas', (await count(app, `SELECT count(*) n FROM contact`)) === 0);
  await app.query('ROLLBACK');

  console.log('\n8 · Identidad de usuario sin empresa: sólo lo suyo, y sólo lectura');
  {
    const asUser = async (userId, fn) => {
      await app.query('BEGIN');
      try {
        await app.query(`SELECT set_config('app.user_id', $1, true)`, [userId]);
        return await fn();
      } finally {
        await app.query('ROLLBACK');
      }
    };

    await asUser(lucia, async () => {
      const memberships = await count(app, 'SELECT count(*) n FROM membership');
      check(
        `Lucía ve sus membresías (1), no las ${acmeMemberships} de Acme`,
        memberships === 1,
        `ve ${memberships}`,
      );
      const tenants = await app.query('SELECT slug FROM tenant');
      check(
        'Lucía ve sólo las empresas a las que pertenece',
        tenants.rows.length === 1 && tenants.rows[0].slug === 'acme',
        tenants.rows.map((r) => r.slug).join(', '),
      );
      const roles = await count(app, 'SELECT count(*) n FROM role');
      check('Lucía ve sólo su propio rol, no los cinco de Acme', roles === 1, `ve ${roles}`);
      const contacts = await count(app, 'SELECT count(*) n FROM contact');
      check(
        'con identidad de usuario pero sin empresa, los contactos siguen ocultos',
        contacts === 0,
      );

      await expectRejected(app, 'con identidad de usuario, crear una membresía propia', () =>
        app.query(
          `INSERT INTO membership (tenant_id, user_id, role_id, status, updated_at)
           SELECT m.tenant_id, m.user_id, m.role_id, 'ACTIVE', now() FROM membership m LIMIT 1`,
        ),
      );
    });

    await asUser(borealOwner, async () => {
      const tenants = await app.query('SELECT slug FROM tenant');
      check(
        'el dueño de Boreal ve Boreal y no Acme',
        tenants.rows.length === 1 && tenants.rows[0].slug === 'boreal',
        tenants.rows.map((r) => r.slug).join(', '),
      );
    });
  }

  console.log('\n8b · Identidad de webhook: sólo el canal de la URL, y sólo lectura');
  {
    // Todo en una transacción que se deshace: los canales sólo existen aquí.
    await app.query('BEGIN');
    try {
      const insertChannel = async (tenantId, externalId) => {
        await app.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
        const { rows } = await app.query(
          `INSERT INTO channel (tenant_id, type, name, external_id, updated_at)
           VALUES ($1, 'WHATSAPP_CLOUD', 'Prueba', $2, now()) RETURNING id`,
          [tenantId, externalId],
        );
        return rows[0].id;
      };
      const acmeChannel = await insertChannel(acme, `iso-acme-${Date.now()}`);
      const borealChannel = await insertChannel(boreal, `iso-boreal-${Date.now()}`);

      // Sin empresa, con la identidad del webhook del canal de Acme.
      await app.query(`SELECT set_config('app.tenant_id', '', true)`);
      await app.query(`SELECT set_config('app.webhook_channel_id', $1, true)`, [acmeChannel]);

      const visible = await app.query('SELECT id, tenant_id FROM channel');
      check(
        'el webhook ve su canal y sólo ese, con la empresa a la que pertenece',
        visible.rows.length === 1 &&
          visible.rows[0].id === acmeChannel &&
          visible.rows[0].tenant_id === acme,
        `ve ${visible.rows.length}`,
      );
      check(
        'no ve el canal de otra empresa aunque sepa que existe',
        (await count(app, 'SELECT count(*) n FROM channel WHERE id = $1', [borealChannel])) === 0,
      );
      check(
        'con identidad de webhook, contactos y conversaciones siguen ocultos',
        (await count(app, 'SELECT count(*) n FROM contact')) === 0 &&
          (await count(app, 'SELECT count(*) n FROM conversation')) === 0,
      );
      const { rowCount: renamed } = await app.query(
        `UPDATE channel SET name = 'Tocado' WHERE id = $1`,
        [acmeChannel],
      );
      check('con identidad de webhook no se puede modificar el canal', renamed === 0);
    } finally {
      await app.query('ROLLBACK');
    }
  }

  console.log('\n9 · Alta de empresa: sólo la del contexto activo');
  {
    const { rows } = await app.query('SELECT uuid_generate_v7()::text AS id');
    const newId = rows[0].id;

    await app.query('BEGIN');
    await expectRejected(app, 'insertar una empresa SIN contexto', () =>
      app.query(
        `INSERT INTO tenant (id, slug, name, updated_at) VALUES ($1, $2, 'Sin contexto', now())`,
        [newId, `prueba-${newId.slice(-12)}`],
      ),
    );
    await app.query('ROLLBACK');

    await app.query('BEGIN');
    await app.query(`SELECT set_config('app.tenant_id', $1, true)`, [newId]);
    await expectAllowed(
      app,
      'control: con el contexto de su propio id, SÍ se inserta',
      async () => {
        // RETURNING, como hace Prisma: la fila devuelta también debe pasar la
        // política de lectura. Era lo que hacía imposible el registro.
        const { rows: created } = await app.query(
          `INSERT INTO tenant (id, slug, name, updated_at) VALUES ($1, $2, 'Con contexto', now()) RETURNING id`,
          [newId, `prueba-${newId.slice(-12)}`],
        );
        if (created[0]?.id !== newId) throw new Error('RETURNING no devolvió la fila');
      },
    );
    await expectRejected(app, 'con contexto de una empresa, insertar OTRA empresa', () =>
      app.query(
        `INSERT INTO tenant (id, slug, name, updated_at) VALUES (uuid_generate_v7(), $1, 'Otra', now())`,
        [`otra-${newId.slice(-12)}`],
      ),
    );
    await app.query('ROLLBACK');
  }

  await app.end();

  console.log('\n10 · La verificación detecta tablas con datos de empresa sin tenant_id');
  {
    // Se simula el error que tuvo role_permission: una tabla hija que cuelga de
    // una tabla protegida sin tener tenant_id propio. Todo dentro de una
    // transacción que se deshace: la tabla nunca llega a existir.
    const ownerCheck = new pg.Client({ connectionString: clean(OWNER_URL) });
    await ownerCheck.connect();
    await ownerCheck.query('BEGIN');
    await ownerCheck.query(
      'CREATE TABLE prueba_hija_sin_tenant (id uuid PRIMARY KEY, contact_id uuid REFERENCES contact(id))',
    );
    const { rows: found } = await ownerCheck.query(
      `SELECT problem FROM verify_tenant_isolation() WHERE table_name = 'prueba_hija_sin_tenant'`,
    );
    await ownerCheck.query('ROLLBACK');
    await ownerCheck.end();
    check(
      'una tabla que referencia a contact sin tenant_id se señala como agujero',
      found.length > 0,
      found[0]?.problem ?? 'no la detectó',
    );
  }

  // --- Resumen ---------------------------------------------------------------
  const failed = results.filter((r) => !r.passed);
  console.log(
    `\n${results.length - failed.length}/${results.length} comprobaciones superadas` +
      (failed.length ? ` — ${failed.length} FALLIDA(S)` : ''),
  );

  if (failed.length) {
    console.error('\nAISLAMIENTO ROTO. No continuar hasta corregirlo.');
    process.exit(1);
  }
  console.log('Aislamiento entre empresas: verificado contra la base real.\n');
}

main().catch((error) => {
  console.error('\nLa prueba no pudo completarse:\n', error);
  process.exit(1);
});
