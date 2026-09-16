/**
 * Semilla de desarrollo.
 *
 * Deja el sistema en un estado en el que se puede TRABAJAR nada más levantarlo:
 * una empresa con equipo, embudo poblado, contactos con historial y tareas
 * vencidas. No es una demo de cartón — es lo mínimo para poder juzgar si las
 * pantallas funcionan, porque una tabla vacía no revela nada.
 *
 * Crea además una SEGUNDA empresa con datos propios. No es decorativa: es
 * contra la que corren las pruebas de aislamiento. Sin dos empresas reales no
 * hay forma de comprobar que una no ve a la otra.
 *
 *   pnpm db:seed          (o `pnpm db:reset` para recrear desde cero)
 *
 * Se ejecuta UNA vez sobre una base recién migrada. No es idempotente: una
 * segunda ejecución falla al repetir correos de contacto, que son únicos. Para
 * volver a sembrar: `pnpm db:reset`.
 */
import { argon2Sync, randomBytes } from 'node:crypto';
import { PrismaClient, Prisma, type User } from '@prisma/client';
import { ROLE_PRESETS } from '../../contracts/src/permissions';

/**
 * El seed conecta con el rol DUEÑO (DIRECT_DATABASE_URL), no con `nexo_app`.
 *
 * Sembrar es una operación de administración, como migrar. Y con `nexo_app`
 * sería imposible: crear una empresa hace `INSERT ... RETURNING`, y Postgres
 * exige que la fila devuelta pase la política de LECTURA — que sólo deja ver la
 * empresa del contexto activo, y al crearla todavía no hay contexto.
 *
 * El rol dueño es superusuario en desarrollo, y los superusuarios no están
 * sujetos a RLS. `asTenant` se mantiene igualmente: documenta a qué empresa
 * pertenece cada bloque y hace que el seed siga funcionando si algún día corre
 * con un rol que sí respete las políticas.
 */
const prisma = new PrismaClient({
  datasourceUrl: process.env.DIRECT_DATABASE_URL ?? process.env.DATABASE_URL,
});

/* ========================================================================== */
/*  Utilidades                                                                */
/* ========================================================================== */

/** Ejecuta `fn` con `app.tenant_id` fijado, como lo haría la aplicación. */
async function asTenant<T>(tenantId: string, fn: (tx: Prisma.TransactionClient) => Promise<T>) {
  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}::text, true)`;
      return fn(tx);
    },
    { timeout: 120_000 },
  );
}

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);
const daysAhead = (n: number) => new Date(Date.now() + n * 86_400_000);
/** Elemento `i` de forma circular. Un array vacío es un error del seed, no un `undefined` silencioso. */
function pick<T>(arr: readonly T[], i: number): T {
  const value = arr[i % arr.length];
  if (value === undefined) throw new Error('pick() sobre un array vacío');
  return value;
}

/** Valor obligatorio de un Map: si falta, el seed está mal escrito y conviene saberlo ya. */
function required<K, V>(map: ReadonlyMap<K, V>, key: K): V {
  const value = map.get(key);
  if (value === undefined) throw new Error(`Falta la clave ${String(key)}`);
  return value;
}

/** "Sebastián" → "sebastian". Escapes Unicode, no caracteres combinantes literales. */
const slugify = (value: string): string =>
  value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');

/**
 * Contraseña de desarrollo, con su hash CALCULADO al ejecutar el seed.
 *
 * Usa Argon2id nativo de Node (`node:crypto`, Node ≥ 24), verificado contra el
 * vector de prueba de RFC 9106 §5.3. Sin dependencias nativas que compilar.
 *
 * Parámetros: los mínimos recomendados por OWASP para Argon2id
 * (19 MiB de memoria, 2 pasadas, 1 hilo). Formato PHC estándar, el mismo que
 * producirá y verificará la autenticación de la Fase 1:
 *
 *   $argon2id$v=19$m=19456,t=2,p=1$<sal base64>$<hash base64>
 *
 * Cada ejecución genera una sal aleatoria, así que el hash cambia aunque la
 * contraseña sea la misma. Es lo correcto.
 *
 * En producción el seed no se ejecuta nunca.
 */
const DEV_PASSWORD = 'Desarrollo123!';

function hashPassword(password: string): string {
  const memory = 19_456;
  const passes = 2;
  const parallelism = 1;
  const salt = randomBytes(16);

  const hash = argon2Sync('argon2id', {
    message: Buffer.from(password, 'utf8'),
    nonce: salt,
    memory,
    passes,
    parallelism,
    tagLength: 32,
  });

  // PHC usa base64 estándar SIN relleno.
  const b64 = (buf: Buffer) => buf.toString('base64').replace(/=+$/, '');
  return `$argon2id$v=19$m=${memory},t=${passes},p=${parallelism}$${b64(salt)}$${b64(hash)}`;
}

const DEV_PASSWORD_HASH = hashPassword(DEV_PASSWORD);

/* ========================================================================== */
/*  1 · Planes de la plataforma                                               */
/* ========================================================================== */

async function seedPlans() {
  const plans = [
    {
      code: 'free',
      name: 'Gratis',
      description: 'Para probar el producto con un equipo pequeño.',
      priceMonthly: 0,
      priceYearly: 0,
      maxUsers: 2,
      maxContacts: 500,
      maxChannels: 0,
      maxWorkflows: 1,
      maxAiSources: 0,
      maxStorageMb: 256,
      monthlyAiCredits: 0,
      monthlyMessages: 0,
      trialDays: 0,
      isDefault: false,
      sortOrder: 0,
      features: { 'whatsapp': false, 'ai.rag': false, 'automation.visual': false, 'api.public': false },
    },
    {
      code: 'starter',
      name: 'Starter',
      description: 'Un equipo comercial con WhatsApp y embudo.',
      priceMonthly: 29,
      priceYearly: 290,
      maxUsers: 5,
      maxContacts: 5_000,
      maxChannels: 1,
      maxWorkflows: 5,
      maxAiSources: 10,
      maxStorageMb: 5_120,
      monthlyAiCredits: 50_000,
      monthlyMessages: 2_000,
      trialDays: 14,
      isDefault: true,
      sortOrder: 1,
      features: { 'whatsapp': true, 'ai.rag': true, 'automation.visual': true, 'api.public': false },
    },
    {
      code: 'pro',
      name: 'Pro',
      description: 'Varios embudos, automatizaciones sin límite y API.',
      priceMonthly: 79,
      priceYearly: 790,
      maxUsers: 20,
      maxContacts: 50_000,
      maxChannels: 3,
      maxWorkflows: -1,
      maxAiSources: 100,
      maxStorageMb: 51_200,
      monthlyAiCredits: 500_000,
      monthlyMessages: 20_000,
      trialDays: 14,
      isDefault: false,
      sortOrder: 2,
      features: { 'whatsapp': true, 'ai.rag': true, 'automation.visual': true, 'api.public': true, 'custom_roles': true },
    },
    {
      code: 'business',
      name: 'Business',
      description: 'Sin límites, roles a medida y soporte prioritario.',
      priceMonthly: 199,
      priceYearly: 1_990,
      maxUsers: -1,
      maxContacts: -1,
      maxChannels: 10,
      maxWorkflows: -1,
      maxAiSources: -1,
      maxStorageMb: 512_000,
      monthlyAiCredits: 2_000_000,
      monthlyMessages: 100_000,
      trialDays: 30,
      isDefault: false,
      sortOrder: 3,
      features: { 'whatsapp': true, 'ai.rag': true, 'automation.visual': true, 'api.public': true, 'custom_roles': true, 'sso': true },
    },
  ];

  for (const { features, ...plan } of plans) {
    const created = await prisma.plan.upsert({
      where: { code: plan.code },
      update: plan,
      create: plan,
    });

    for (const [key, enabled] of Object.entries(features)) {
      await prisma.planFeature.upsert({
        where: { planId_key: { planId: created.id, key } },
        update: { enabled },
        create: { planId: created.id, key, enabled },
      });
    }
  }

  console.log(`  · ${plans.length} planes`);
  return prisma.plan.findMany();
}

/* ========================================================================== */
/*  2 · Operador de la plataforma                                             */
/* ========================================================================== */

async function seedPlatformAdmin() {
  await prisma.platformAdmin.upsert({
    where: { email: 'admin@nexo.local' },
    update: {},
    create: {
      email: 'admin@nexo.local',
      passwordHash: DEV_PASSWORD_HASH,
      name: 'Operador de plataforma',
      // En producción el 2FA es obligatorio para este rol y se fuerza al
      // primer inicio de sesión. En local se deja desactivado para no
      // necesitar un autenticador sólo para entrar.
      totpEnabled: false,
    },
  });
  console.log('  · operador de plataforma: admin@nexo.local');
}

/* ========================================================================== */
/*  3 · Una empresa completa                                                  */
/* ========================================================================== */

interface TenantSpec {
  slug: string;
  name: string;
  people: Array<{ email: string; name: string; role: string; team?: string }>;
  /** Cuántos contactos generar. */
  contactCount: number;
}

async function seedTenant(spec: TenantSpec, planId: string) {
  // --- La empresa. Fuera de asTenant: todavía no existe ---------------------
  const tenant = await prisma.tenant.upsert({
    where: { slug: spec.slug },
    update: {},
    create: {
      slug: spec.slug,
      name: spec.name,
      status: 'ACTIVE',
      country: 'EC',
      city: 'Quito',
      timezone: 'America/Guayaquil',
      currency: 'USD',
      locale: 'es',
      brandColor: spec.slug === 'acme' ? '#0C6B60' : '#7C3AED',
    },
  });

  // --- Los usuarios. `user` no lleva RLS: es identidad global ---------------
  const users: User[] = [];
  for (const person of spec.people) {
    users.push(
      await prisma.user.upsert({
        where: { email: person.email },
        update: {},
        create: {
          email: person.email,
          name: person.name,
          passwordHash: DEV_PASSWORD_HASH,
          status: 'ACTIVE',
          emailVerifiedAt: new Date(),
          timezone: 'America/Guayaquil',
        },
      }),
    );
  }

  // --- Todo lo demás, ya con contexto de empresa ---------------------------
  await asTenant(tenant.id, async (tx) => {
    // Suscripción
    await tx.subscription.upsert({
      where: { tenantId: tenant.id },
      update: {},
      create: {
        tenantId: tenant.id,
        planId,
        status: 'ACTIVE',
        interval: 'MONTHLY',
        currentPeriodStart: daysAgo(12),
        currentPeriodEnd: daysAhead(18),
      },
    });

    // Roles del sistema con sus permisos
    const roleByKey = new Map<string, string>();
    for (const preset of ROLE_PRESETS) {
      const role = await tx.role.upsert({
        where: { tenantId_name: { tenantId: tenant.id, name: preset.name } },
        update: {},
        create: {
          tenantId: tenant.id,
          key: preset.key,
          name: preset.name,
          description: preset.description,
          isSystem: true,
        },
      });
      roleByKey.set(preset.key, role.id);

      const rows = Object.entries(preset.permissions).map(([permission, scope]) => ({
        roleId: role.id,
        permission,
        scope: scope as 'ALL' | 'TEAM' | 'OWN',
      }));
      await tx.rolePermission.createMany({ data: rows, skipDuplicates: true });
    }

    // Membresías
    for (const [i, person] of spec.people.entries()) {
      const user = pick(users, i);
      await tx.membership.upsert({
        where: { tenantId_userId: { tenantId: tenant.id, userId: user.id } },
        update: {},
        create: {
          tenantId: tenant.id,
          userId: user.id,
          roleId: required(roleByKey, person.role),
          status: 'ACTIVE',
          teamName: person.team ?? null,
          acceptedAt: daysAgo(60 - i),
        },
      });
    }

    // Impuesto
    const tax = await tx.taxRate.upsert({
      where: { tenantId_name: { tenantId: tenant.id, name: 'IVA 15%' } },
      update: {},
      create: { tenantId: tenant.id, name: 'IVA 15%', percent: 15, isDefault: true },
    });

    // Etiquetas
    const tagNames = [
      ['Caliente', '#DC2626'],
      ['Tibio', '#F59E0B'],
      ['Frío', '#3B82F6'],
      ['Referido', '#8B5CF6'],
      ['Feria', '#10B981'],
    ] as const;
    const tags = [];
    for (const [name, color] of tagNames) {
      tags.push(
        await tx.tag.upsert({
          where: { tenantId_name: { tenantId: tenant.id, name } },
          update: {},
          create: { tenantId: tenant.id, name, color },
        }),
      );
    }

    // Motivos de pérdida
    const lostReasons = ['Precio', 'Eligió a un competidor', 'Sin presupuesto', 'Mal momento', 'Sin respuesta'];
    const lostReasonIds = [];
    for (const [i, name] of lostReasons.entries()) {
      const r = await tx.lostReason.upsert({
        where: { tenantId_name: { tenantId: tenant.id, name } },
        update: {},
        create: { tenantId: tenant.id, name, sortOrder: i },
      });
      lostReasonIds.push(r.id);
    }

    // Productos
    const productSpecs = [
      ['IMP-001', 'Implementación inicial', 1_200],
      ['LIC-010', 'Licencia mensual · 10 usuarios', 290],
      ['SOP-PRE', 'Soporte prioritario', 150],
      ['CAP-004', 'Capacitación (4 h)', 400],
    ] as const;
    for (const [sku, name, price] of productSpecs) {
      await tx.product.upsert({
        where: { tenantId_sku: { tenantId: tenant.id, sku } },
        update: {},
        create: {
          tenantId: tenant.id,
          sku,
          name,
          unitPrice: price,
          taxRateId: tax.id,
        },
      });
    }

    // --- Embudo con las siete etapas aprobadas ----------------------------
    const pipeline = await tx.pipeline.upsert({
      where: { tenantId_name: { tenantId: tenant.id, name: 'Embudo comercial' } },
      update: {},
      create: { tenantId: tenant.id, name: 'Embudo comercial', isDefault: true },
    });

    const stageSpecs = [
      ['Nuevo', 'OPEN', 10, '#64748B', 7],
      ['Contactado', 'OPEN', 20, '#3B82F6', 7],
      ['Calificado', 'OPEN', 40, '#6366F1', 10],
      ['Cotización enviada', 'OPEN', 60, '#8B5CF6', 14],
      ['Negociación', 'OPEN', 80, '#F59E0B', 14],
      ['Ganado', 'WON', 100, '#10B981', null],
      ['Perdido', 'LOST', 0, '#EF4444', null],
    ] as const;

    const stages = [];
    for (const [i, [name, type, probability, color, rotting]] of stageSpecs.entries()) {
      stages.push(
        await tx.pipelineStage.upsert({
          where: { pipelineId_name: { pipelineId: pipeline.id, name } },
          update: {},
          create: {
            tenantId: tenant.id,
            pipelineId: pipeline.id,
            name,
            type,
            probability,
            color,
            position: (i + 1) * 1000,
            rottingDays: rotting,
          },
        }),
      );
    }

    // Secuencias de numeración del año en curso
    const year = new Date().getFullYear();
    for (const kind of ['QUOTE', 'PROFORMA', 'INVOICE'] as const) {
      await tx.numberSequence.upsert({
        where: { tenantId_kind_series_year: { tenantId: tenant.id, kind, series: '001', year } },
        update: {},
        create: {
          tenantId: tenant.id,
          kind,
          series: '001',
          year,
          prefix: kind === 'INVOICE' ? 'FAC' : kind === 'QUOTE' ? 'COT' : 'PRO',
        },
      });
    }

    // Ajustes de IA (desactivada hasta que haya clave — Fase 3)
    await tx.aiSetting.upsert({
      where: { tenantId: tenant.id },
      update: {},
      create: {
        tenantId: tenant.id,
        enabled: false,
        assistantName: 'Nexo',
        tone: 'cercano y profesional',
      },
    });

    // --- Empresas cliente --------------------------------------------------
    const companyNames = [
      'Andina Logística',
      'Textiles del Pacífico',
      'Constructora Kairós',
      'Clínica San Rafael',
      'Agro Exportadora Sur',
      'Distribuidora Mendoza',
      'Estudio Jurídico Vera',
      'Hotel Casa Quinde',
    ];
    const companies = [];
    for (const name of companyNames) {
      companies.push(
        await tx.company.create({
          data: {
            tenantId: tenant.id,
            name,
            city: pick(['Quito', 'Guayaquil', 'Cuenca', 'Ambato'], companies.length),
            country: 'EC',
            industry: pick(['Logística', 'Manufactura', 'Construcción', 'Salud', 'Agro'], companies.length),
          },
        }),
      );
    }

    // --- Contactos ---------------------------------------------------------
    const firstNames = [
      'María', 'Juan', 'Andrea', 'Carlos', 'Paola', 'Diego', 'Gabriela', 'Luis',
      'Verónica', 'Santiago', 'Daniela', 'Fernando', 'Cristina', 'Ricardo',
      'Mónica', 'Esteban', 'Karla', 'Javier', 'Silvia', 'Marco',
    ];
    const lastNames = [
      'Pérez', 'Gómez', 'Vásquez', 'Chávez', 'Andrade', 'Salazar', 'Moreno',
      'Cedeño', 'Jaramillo', 'Paredes', 'Cabrera', 'Tapia', 'Vega', 'Zambrano',
    ];
    const jobTitles = [
      'Gerente General', 'Jefa de Compras', 'Director Comercial', 'Coordinador de TI',
      'Gerente de Operaciones', 'Analista de Proyectos', 'Dueña', 'Contador',
    ];

    const contacts = [];
    for (let i = 0; i < spec.contactCount; i++) {
      const firstName = pick(firstNames, i);
      const lastName = pick(lastNames, i * 3 + 1);
      const company = pick(companies, i);
      // Teléfono ecuatoriano válido en E.164; determinista para que el seed
      // sea reproducible y las pruebas puedan referirse a un contacto concreto.
      const phone = `+5939${String(80_000_000 + i * 137_911).slice(0, 8)}`;

      contacts.push(
        await tx.contact.create({
          data: {
            tenantId: tenant.id,
            firstName,
            lastName,
            jobTitle: pick(jobTitles, i),
            companyId: company.id,
            companyName: company.name,
            email: `${slugify(firstName)}.${slugify(lastName)}${i}@${spec.slug}-demo.com`,
            phoneE164: phone,
            whatsappE164: phone,
            city: company.city,
            country: 'EC',
            lifecycleStage: i % 5 === 0 ? 'CUSTOMER' : i % 3 === 0 ? 'PROSPECT' : 'LEAD',
            source: pick(['whatsapp', 'web', 'referido', 'feria', 'manual'], i),
            ownerId: pick(users, i).id,
            lastActivityAt: daysAgo(i % 30),
            createdAt: daysAgo(90 - (i % 90)),
          },
        }),
      );

      // Etiquetar una parte
      if (i % 3 === 0) {
        await tx.contactTag.create({
          data: { tenantId: tenant.id, contactId: pick(contacts, i).id, tagId: pick(tags, i).id },
        });
      }
    }

    // --- Oportunidades repartidas por el embudo ----------------------------
    const dealTitles = [
      'Implementación CRM',
      'Renovación anual',
      'Ampliación de licencias',
      'Migración de datos',
      'Capacitación del equipo',
      'Soporte prioritario',
      'Proyecto piloto',
    ];

    let dealCount = 0;
    for (let i = 0; i < Math.floor(spec.contactCount * 0.7); i++) {
      const contact = pick(contacts, i);
      // Reparto realista: la mayoría arriba del embudo, pocas cerradas.
      const stageIndex =
        i % 11 === 0 ? 5 : i % 13 === 0 ? 6 : i % 5;
      const stage = pick(stages, stageIndex);
      const value = 800 + ((i * 673) % 14_000);
      const isClosed = stage.type !== 'OPEN';

      const deal = await tx.deal.create({
        data: {
          tenantId: tenant.id,
          title: `${pick(dealTitles, i)} · ${contact.companyName}`,
          pipelineId: pipeline.id,
          stageId: stage.id,
          contactId: contact.id,
          companyId: contact.companyId,
          ownerId: contact.ownerId,
          value: new Prisma.Decimal(value),
          currency: 'USD',
          probability: stage.probability,
          status: stage.type === 'WON' ? 'WON' : stage.type === 'LOST' ? 'LOST' : 'OPEN',
          position: (i + 1) * 1000,
          expectedCloseAt: daysAhead(((i * 7) % 60) - 10),
          closedAt: isClosed ? daysAgo(i % 25) : null,
          lostReasonId: stage.type === 'LOST' ? pick(lostReasonIds, i) : null,
          stageEnteredAt: daysAgo(i % 21),
          lastActivityAt: daysAgo(i % 14),
          createdAt: daysAgo(60 - (i % 60)),
        },
      });
      dealCount++;

      // Historial de etapa: sin esto desde el primer día, la métrica de
      // "tiempo medio en cada etapa" no se puede reconstruir nunca.
      await tx.dealStageHistory.create({
        data: {
          tenantId: tenant.id,
          dealId: deal.id,
          stageId: stage.id,
          movedByUserId: contact.ownerId,
          enteredAt: daysAgo(i % 21),
        },
      });

      // Timeline
      await tx.activity.create({
        data: {
          tenantId: tenant.id,
          type: 'STAGE_CHANGE',
          subjectType: 'Deal',
          subjectId: deal.id,
          contactId: contact.id,
          dealId: deal.id,
          actorId: contact.ownerId,
          title: `Oportunidad movida a ${stage.name}`,
          payload: { toStage: stage.name, value },
          occurredAt: daysAgo(i % 21),
        },
      });
    }

    // --- Tareas, algunas vencidas a propósito ------------------------------
    const taskTitles = [
      'Llamar para confirmar la reunión',
      'Enviar la cotización revisada',
      'Hacer seguimiento tras la demo',
      'Preparar propuesta técnica',
      'Pedir los datos de facturación',
      'Agendar visita a planta',
    ];
    for (let i = 0; i < Math.floor(spec.contactCount * 0.5); i++) {
      const overdue = i % 4 === 0;
      await tx.task.create({
        data: {
          tenantId: tenant.id,
          title: pick(taskTitles, i),
          status: i % 5 === 0 ? 'DONE' : 'PENDING',
          priority: pick(['LOW', 'MEDIUM', 'HIGH', 'URGENT'] as const, i),
          dueAt: overdue ? daysAgo((i % 8) + 1) : daysAhead(i % 14),
          completedAt: i % 5 === 0 ? daysAgo(i % 5) : null,
          assigneeId: pick(users, i).id,
          creatorId: pick(users, 0).id,
          contactId: pick(contacts, i).id,
        },
      });
    }

    // --- Notas -------------------------------------------------------------
    const noteBodies = [
      'Pidió que le llamemos después de las 15:00. Prefiere WhatsApp para lo urgente.',
      'Trabajan con un competidor desde hace dos años; el contrato vence en marzo.',
      'Decisión la toma el directorio. Nuestro contacto es quien la recomienda.',
      'Presupuesto aprobado, pero quieren empezar el próximo trimestre.',
    ];
    for (let i = 0; i < Math.min(12, contacts.length); i++) {
      await tx.note.create({
        data: {
          tenantId: tenant.id,
          body: pick(noteBodies, i),
          contactId: pick(contacts, i).id,
          authorId: pick(users, i).id,
          createdAt: daysAgo(i * 2),
        },
      });
    }

    // --- Panel por defecto -------------------------------------------------
    const dashboard = await tx.dashboard.create({
      data: {
        tenantId: tenant.id,
        name: 'Resumen comercial',
        isDefault: true,
        preset: 'sales',
      },
    });

    const widgets = [
      { type: 'KPI' as const, title: 'Oportunidades abiertas', query: { metric: 'deal.count', filter: { status: 'OPEN' } } },
      { type: 'KPI' as const, title: 'Valor del embudo', query: { metric: 'deal.sum', field: 'value', filter: { status: 'OPEN' } } },
      { type: 'KPI' as const, title: 'Ganado este mes', query: { metric: 'deal.sum', field: 'value', filter: { status: 'WON' }, range: 'month' } },
      { type: 'KPI' as const, title: 'Tasa de conversión', query: { metric: 'deal.winRate', range: 'quarter' } },
      { type: 'FUNNEL' as const, title: 'Embudo por etapa', query: { metric: 'deal.count', groupBy: 'stage' } },
      { type: 'LINE' as const, title: 'Ventas por semana', query: { metric: 'deal.sum', field: 'value', groupBy: 'week', filter: { status: 'WON' }, range: 'quarter' } },
      { type: 'BAR' as const, title: 'Ranking por vendedor', query: { metric: 'deal.sum', field: 'value', groupBy: 'owner', filter: { status: 'WON' }, range: 'month' } },
      { type: 'PIE' as const, title: 'Origen de los leads', query: { metric: 'contact.count', groupBy: 'source' } },
    ];
    for (const [i, widget] of widgets.entries()) {
      await tx.widget.create({
        data: { tenantId: tenant.id, dashboardId: dashboard.id, ...widget, sortOrder: i },
      });
    }

    console.log(
      `  · ${spec.name}: ${spec.people.length} usuarios · ${contacts.length} contactos · ${dealCount} oportunidades`,
    );
  });

  return tenant;
}

/* ========================================================================== */

async function main() {
  console.log('\nSembrando Nexo CRM…\n');

  const plans = await seedPlans();
  await seedPlatformAdmin();

  const planByCode = new Map(plans.map((p) => [p.code, p.id]));

  await seedTenant(
    {
      slug: 'acme',
      name: 'Acme Servicios',
      contactCount: 40,
      people: [
        { email: 'sebastian@acme.test', name: 'Sebastián Tulcán', role: 'OWNER' },
        { email: 'ana@acme.test', name: 'Ana Villacís', role: 'ADMIN' },
        { email: 'pedro@acme.test', name: 'Pedro Landázuri', role: 'MANAGER', team: 'Sierra' },
        { email: 'lucia@acme.test', name: 'Lucía Benítez', role: 'AGENT', team: 'Sierra' },
        { email: 'tomas@acme.test', name: 'Tomás Reinoso', role: 'AGENT', team: 'Costa' },
        { email: 'directora@acme.test', name: 'Rocío Ampudia', role: 'VIEWER' },
      ],
    },
    planByCode.get('pro')!,
  );

  // Segunda empresa: existe para que las pruebas de aislamiento tengan contra
  // qué comprobar. Sus datos NUNCA deben aparecer en una consulta de la
  // primera, y hay una suite dedicada a verificarlo endpoint por endpoint.
  await seedTenant(
    {
      slug: 'boreal',
      name: 'Boreal Consultores',
      contactCount: 15,
      people: [
        { email: 'owner@boreal.test', name: 'Martín Ocaña', role: 'OWNER' },
        { email: 'agente@boreal.test', name: 'Sofía Erazo', role: 'AGENT' },
      ],
    },
    planByCode.get('starter')!,
  );

  console.log(`\nListo. Contraseña de todas las cuentas: ${DEV_PASSWORD}\n`);
  console.log('  Producto:   http://localhost:3000/w/acme');
  console.log('  Plataforma: http://localhost:3000/admin  (admin@nexo.local)\n');
}

main()
  .catch((error) => {
    console.error('\nEl seed falló:\n', error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
