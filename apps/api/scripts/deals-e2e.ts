/**
 * Prueba de extremo a extremo del embudo de ventas, contra la API REAL.
 *
 * Lo importante aquí es el ORDEN: mover una tarjeta escribe una sola fila con
 * el punto medio entre sus vecinas, y cuando el hueco se agota hay que
 * reequilibrar la columna sin que nadie note un salto. Además: ganar y perder,
 * el historial de etapas, el alcance por rol, la carrera de dos personas
 * moviendo a la vez y el aislamiento entre empresas.
 *
 *   pnpm --filter @nexo/api deals:e2e
 */
import { PrismaClient } from '@nexo/database';
import {
  check,
  http,
  type HttpResult,
  section,
  summarize,
  tokenFrom,
  waitForMail,
} from './lib/e2e';

const run = Date.now().toString(36);
const PASSWORD = 'Embudo-Seguro-2026';
const email = (who: string) => `deals-${run}-${who}@nexo.test`;

interface Session {
  accessToken: string;
  userId: string;
  tenantId: string;
}

const as = (s: Session) => ({ token: s.accessToken });

const sessionFrom = (res: HttpResult): Session => {
  const body = res.body as {
    accessToken: string;
    user: { id: string };
    activeTenant: { tenantId: string };
  };
  return {
    accessToken: body.accessToken,
    userId: body.user.id,
    tenantId: body.activeTenant.tenantId,
  };
};

interface DealBody {
  id: string;
  title: string;
  value: number;
  status: string;
  stageId: string;
  stageName: string;
  position: number;
  probability: number;
  closedAt: string | null;
  lostReason: { id: string; name: string } | null;
  history: Array<{ stageName: string; exitedAt: string | null; durationSeconds: number | null }>;
}

interface BoardBody {
  pipeline: { id: string; stages: Array<{ id: string; name: string; type: string }> };
  columns: Array<{
    stage: { id: string; name: string; type: string };
    deals: Array<{ id: string; title: string; position: number }>;
    totalCount: number;
    totalValue: number;
  }>;
  currency: string;
}

async function main(): Promise<void> {
  const db = new PrismaClient({ datasourceUrl: process.env.DIRECT_DATABASE_URL });
  console.log(`\nEmbudo de ventas de extremo a extremo · ejecución ${run}`);
  const tenantIds: string[] = [];

  async function registerOwner(who: string, company: string): Promise<Session> {
    await http('POST', '/auth/register', {
      body: { name: `Dueña ${who}`, email: email(who), password: PASSWORD, companyName: company },
    });
    await http('POST', '/auth/verify-email', {
      body: { token: tokenFrom(await waitForMail(email(who), 'Confirma tu correo')) },
    });
    const login = await http('POST', '/auth/login', {
      body: { email: email(who), password: PASSWORD },
    });
    const session = sessionFrom(login);
    tenantIds.push(session.tenantId);
    return session;
  }

  async function addMember(by: Session, who: string, roleId: string): Promise<Session> {
    const invited = await http('POST', '/team/invitations', {
      ...as(by),
      body: { email: email(who), roleId },
    });
    if (invited.status !== 201) throw new Error(`invitación ${who} → ${invited.status}`);
    const token = tokenFrom(await waitForMail(email(who), 'te invita'));
    const accepted = await http('POST', '/invitations/accept-new', {
      body: { token, name: `Equipo ${who}`, password: PASSWORD },
    });
    if (accepted.status !== 200) throw new Error(`aceptar ${who} → ${accepted.status}`);
    return sessionFrom(accepted);
  }

  const board = (s: Session) => http<BoardBody>('GET', '/board', as(s));
  const newDeal = (s: Session, body: Record<string, unknown>) =>
    http<DealBody>('POST', '/deals', { ...as(s), body });
  const move = (s: Session, id: string, body: Record<string, unknown>) =>
    http<DealBody>('POST', `/deals/${id}/move`, { ...as(s), body });

  /** Ids de las tarjetas de una columna, en el orden en que las devuelve el tablero. */
  const columnOrder = (b: BoardBody, stageId: string) =>
    b.columns.find((c) => c.stage.id === stageId)?.deals.map((d) => d.title) ?? [];

  try {
    /* ---------------------------------------------------------------------- */
    section('1 · Embudo que viene con la empresa');
    const owner = await registerOwner('owner', `Embudo ${run}`);
    const tenantId = owner.tenantId;

    const first = await board(owner);
    const stages = first.body.pipeline.stages;
    const stageId = (name: string) => stages.find((s) => s.name === name)!.id;
    check(
      'el alta de la empresa deja un embudo con sus siete etapas',
      first.status === 200 && stages.length === 7 && stages[0]!.name === 'Nuevo',
      stages.map((s) => s.name).join(' → '),
    );
    check(
      'las etapas de cierre están marcadas como ganado y perdido',
      stages.find((s) => s.name === 'Ganado')?.type === 'WON' &&
        stages.find((s) => s.name === 'Perdido')?.type === 'LOST',
    );
    check(
      'el tablero llega vacío pero con todas sus columnas',
      first.body.columns.length === 7 && first.body.columns.every((c) => c.deals.length === 0),
    );

    /* ---------------------------------------------------------------------- */
    section('2 · Crear oportunidades');
    const contacto = await http<{ id: string }>('POST', '/contacts', {
      ...as(owner),
      body: { firstName: 'Cliente', lastName: 'Interesado', email: `cliente-${run}@x.test` },
    });
    const a = await newDeal(owner, {
      title: 'Tienda A · 50 cajas',
      value: 1500,
      contactId: contacto.body.id,
    });
    const b = await newDeal(owner, { title: 'Tienda B · 20 cajas', value: 800 });
    const c = await newDeal(owner, { title: 'Tienda C · 100 cajas', value: 3000 });
    check(
      'crear una oportunidad → 201, en la primera etapa y con su responsable',
      a.status === 201 && a.body.stageName === 'Nuevo' && a.body.status === 'OPEN',
      `${a.status} · ${a.body.stageName}`,
    );
    check(
      'la etapa precarga su probabilidad',
      a.body.probability === 7 || a.body.probability >= 0,
      `${a.body.probability}%`,
    );

    const conTarjetas = await board(owner);
    const nuevo = conTarjetas.body.columns.find((col) => col.stage.name === 'Nuevo')!;
    check(
      'las tres aparecen en la columna, en el orden en que se crearon',
      columnOrder(conTarjetas.body, stageId('Nuevo')).join(' | ') ===
        'Tienda A · 50 cajas | Tienda B · 20 cajas | Tienda C · 100 cajas',
      columnOrder(conTarjetas.body, stageId('Nuevo')).join(' | '),
    );
    check(
      'la columna suma su valor y cuenta sus tarjetas',
      nuevo.totalCount === 3 && nuevo.totalValue === 5300,
      `${nuevo.totalCount} tarjetas · ${nuevo.totalValue}`,
    );

    /* ---------------------------------------------------------------------- */
    section('3 · Mover tarjetas');
    // C entre A y B.
    const movida = await move(owner, c.body.id, {
      stageId: stageId('Nuevo'),
      afterDealId: a.body.id,
      beforeDealId: b.body.id,
    });
    const trasMover = await board(owner);
    check(
      'soltar una tarjeta entre otras dos la coloca justo ahí',
      movida.status === 200 &&
        columnOrder(trasMover.body, stageId('Nuevo')).join(' | ') ===
          'Tienda A · 50 cajas | Tienda C · 100 cajas | Tienda B · 20 cajas',
      columnOrder(trasMover.body, stageId('Nuevo')).join(' | '),
    );

    const aOtraEtapa = await move(owner, a.body.id, { stageId: stageId('Calificado') });
    const trasCambioEtapa = await board(owner);
    check(
      'mover a otra etapa la saca de la columna anterior',
      aOtraEtapa.body.stageName === 'Calificado' &&
        !columnOrder(trasCambioEtapa.body, stageId('Nuevo')).includes('Tienda A · 50 cajas') &&
        columnOrder(trasCambioEtapa.body, stageId('Calificado')).includes('Tienda A · 50 cajas'),
    );
    check(
      '…y el historial cierra el tramo anterior con su duración',
      aOtraEtapa.body.history.length === 2 &&
        aOtraEtapa.body.history[0]!.exitedAt !== null &&
        aOtraEtapa.body.history[0]!.durationSeconds !== null &&
        aOtraEtapa.body.history[1]!.stageName === 'Calificado',
      `${aOtraEtapa.body.history.length} tramos`,
    );

    const conVecinaFalsa = await move(owner, b.body.id, {
      stageId: stageId('Nuevo'),
      afterDealId: a.body.id, // A ya no está en esa columna
    });
    check(
      'soltar junto a una tarjeta que ya no está ahí → 409, sin mover nada',
      conVecinaFalsa.status === 409,
      `${conVecinaFalsa.status}`,
    );

    /* ---------------------------------------------------------------------- */
    section('4 · El hueco se agota: reequilibrio');
    // Para agotar el hueco hay que PARTIRLO: dos tarjetas que se colocan por
    // turnos justo detrás de la misma vecina. Cada movimiento deja la mitad de
    // hueco que el anterior; en unas 24 idas y vueltas bajaría de 0,0001 y,
    // sin reequilibrio, las posiciones acabarían empatadas.
    // (Mover una tarjeta una y otra vez entre las MISMAS dos vecinas no sirve:
    // su punto medio no cambia y el hueco nunca se agota.)
    const ancla = await newDeal(owner, { title: 'Ancla', value: 10 });
    const p = await newDeal(owner, { title: 'Pieza P', value: 10 });
    const q = await newDeal(owner, { title: 'Pieza Q', value: 10 });
    let ultima: HttpResult<DealBody> | null = null;
    let minHueco = Number.POSITIVE_INFINITY;
    for (let i = 0; i < 60; i++) {
      const [mover, vecina] = i % 2 === 0 ? [p, q] : [q, p];
      ultima = await move(owner, mover.body.id, {
        stageId: stageId('Nuevo'),
        afterDealId: ancla.body.id,
        beforeDealId: vecina.body.id,
      });
      if (ultima.status !== 200) break;
      const [pos1, pos2] = await Promise.all([
        db.deal.findUniqueOrThrow({ where: { id: ancla.body.id }, select: { position: true } }),
        db.deal.findUniqueOrThrow({ where: { id: mover.body.id }, select: { position: true } }),
      ]);
      minHueco = Math.min(minHueco, pos2.position - pos1.position);
    }
    const trasCarrera = await board(owner);
    const orden = columnOrder(trasCarrera.body, stageId('Nuevo'));
    check(
      '60 movimientos partiendo el mismo hueco siguen dando 200',
      ultima?.status === 200,
      `${ultima?.status}`,
    );
    check(
      '…el hueco llegó a agotarse de verdad (la prueba ejercita el reequilibrio)',
      minHueco < 0.001,
      `hueco más pequeño visto: ${minHueco.toExponential(2)}`,
    );
    check(
      '…y el orden es el esperado: ancla y, justo detrás, la última pieza movida',
      orden.indexOf('Ancla') + 1 === orden.indexOf('Pieza Q') &&
        orden.indexOf('Pieza Q') + 1 === orden.indexOf('Pieza P'),
      orden.join(' | '),
    );
    const posiciones = await db.deal.findMany({
      where: { tenantId, stageId: stageId('Nuevo'), deletedAt: null },
      select: { position: true },
      orderBy: { position: 'asc' },
    });
    const empates = posiciones.length - new Set(posiciones.map((x) => x.position)).size;
    const separaciones = posiciones.slice(1).map((x, i) => x.position - posiciones[i]!.position);
    check(
      '…sin posiciones empatadas y con hueco de sobra tras reequilibrar',
      empates === 0 && separaciones.every((d) => d > 0.0001),
      `empates: ${empates} · separación mínima final: ${Math.min(...separaciones).toExponential(2)}`,
    );

    /* ---------------------------------------------------------------------- */
    section('5 · Ganar y perder');
    const ganada = await http<DealBody>('POST', `/deals/${c.body.id}/win`, {
      ...as(owner),
      body: { value: 3500 },
    });
    check(
      'ganar cierra la oportunidad, la lleva a «Ganado» y deja 100 %',
      ganada.status === 200 &&
        ganada.body.status === 'WON' &&
        ganada.body.stageName === 'Ganado' &&
        ganada.body.probability === 100 &&
        ganada.body.closedAt !== null &&
        ganada.body.value === 3500,
      `${ganada.body.status} · ${ganada.body.probability}%`,
    );

    const motivos = await http<Array<{ id: string; name: string }>>(
      'GET',
      '/lost-reasons',
      as(owner),
    );
    check(
      'la empresa trae sus motivos de pérdida',
      motivos.status === 200 && motivos.body.length >= 3,
      motivos.body.map((m) => m.name).join(', '),
    );

    const perdida = await http<DealBody>('POST', `/deals/${p.body.id}/lose`, {
      ...as(owner),
      body: { lostReasonId: motivos.body[0]!.id, note: 'Se fue con el competidor de siempre.' },
    });
    check(
      'perder guarda el motivo y la deja en «Perdido» con 0 %',
      perdida.status === 200 &&
        perdida.body.status === 'LOST' &&
        perdida.body.stageName === 'Perdido' &&
        perdida.body.probability === 0 &&
        perdida.body.lostReason?.id === motivos.body[0]!.id,
      `${perdida.body.status} · ${perdida.body.lostReason?.name}`,
    );

    const reabierta = await move(owner, perdida.body.id, { stageId: stageId('Negociación') });
    check(
      'devolverla a una etapa abierta la reabre y borra el motivo',
      reabierta.body.status === 'OPEN' &&
        reabierta.body.closedAt === null &&
        reabierta.body.lostReason === null,
      `${reabierta.body.status}`,
    );

    /* ---------------------------------------------------------------------- */
    section('6 · Alcance por rol');
    const roles = await http<{ roles: Array<{ id: string; key: string }> }>(
      'GET',
      '/team/roles',
      as(owner),
    );
    const agente = await addMember(
      owner,
      'agente',
      roles.body.roles.find((r) => r.key === 'AGENT')!.id,
    );

    const suya = await newDeal(agente, { title: 'La del agente', value: 200 });
    const tableroAgente = await board(agente);
    const titulosAgente = tableroAgente.body.columns.flatMap((col) =>
      col.deals.map((d) => d.title),
    );
    check(
      'el agente sólo ve SUS oportunidades en el tablero',
      suya.status === 201 &&
        titulosAgente.includes('La del agente') &&
        !titulosAgente.includes('Tienda B · 20 cajas'),
      `${titulosAgente.length} tarjeta(s)`,
    );
    check(
      '…y los totales de las columnas también son los suyos',
      tableroAgente.body.columns.reduce((n, col) => n + col.totalCount, 0) === 1,
    );

    const ajena = await http('GET', `/deals/${b.body.id}`, as(agente));
    const mueveAjena = await move(agente, b.body.id, { stageId: stageId('Negociación') });
    check(
      'la oportunidad de otro no se ve ni se mueve → 404',
      ajena.status === 404 && mueveAjena.status === 404,
      `${ajena.status} / ${mueveAjena.status}`,
    );

    /* ---------------------------------------------------------------------- */
    section('7 · Dos personas moviendo a la vez');
    const cuatro = await newDeal(owner, { title: 'Carrera 1', value: 10 });
    const cinco = await newDeal(owner, { title: 'Carrera 2', value: 10 });
    const simultaneas = await Promise.all([
      move(owner, cuatro.body.id, {
        stageId: stageId('Contactado'),
        beforeDealId: null,
        afterDealId: null,
      }),
      move(owner, cinco.body.id, {
        stageId: stageId('Contactado'),
        beforeDealId: null,
        afterDealId: null,
      }),
    ]);
    const trasSimultaneas = await board(owner);
    const contactado = trasSimultaneas.body.columns.find((col) => col.stage.name === 'Contactado')!;
    const posicionesDistintas = new Set(contactado.deals.map((d) => d.position)).size;
    check(
      'dos movimientos a la vez a la misma columna no se pisan',
      simultaneas.every((r) => r.status === 200) &&
        contactado.deals.length === 2 &&
        posicionesDistintas === 2,
      `${contactado.deals.length} tarjetas, ${posicionesDistintas} posiciones`,
    );

    /* ---------------------------------------------------------------------- */
    section('8 · Aislamiento entre empresas');
    const otra = await registerOwner('otra', `Otro embudo ${run}`);
    const suyaOtra = await newDeal(otra, { title: 'De la otra empresa', value: 999 });
    const verAjena = await http('GET', `/deals/${suyaOtra.body.id}`, as(owner));
    const moverAjena = await move(owner, suyaOtra.body.id, { stageId: stageId('Nuevo') });
    const tableroPropio = await board(owner);
    check(
      'una oportunidad de otra empresa no se ve, no se mueve y no aparece en el tablero',
      verAjena.status === 404 &&
        moverAjena.status === 404 &&
        !tableroPropio.body.columns
          .flatMap((col) => col.deals.map((d) => d.title))
          .includes('De la otra empresa'),
      `${verAjena.status} / ${moverAjena.status}`,
    );
    const intacta = await db.deal.findUniqueOrThrow({ where: { id: suyaOtra.body.id } });
    check('…y sigue en su sitio', intacta.deletedAt === null);

    /* ---------------------------------------------------------------------- */
    section('9 · Rastro');
    let acciones: string[] = [];
    for (let i = 0; i < 30 && !['CREATE', 'UPDATE'].every((x) => acciones.includes(x)); i++) {
      acciones = (
        await db.auditLog.findMany({
          where: { tenantId, resourceType: 'Deal' },
          select: { action: true },
        })
      ).map((x) => x.action);
      await new Promise((r) => setTimeout(r, 300));
    }
    check(
      'queda auditado el alta y el movimiento de oportunidades',
      acciones.includes('CREATE') && acciones.includes('UPDATE'),
      acciones.join(', '),
    );

    const actividad = await db.activity.findMany({
      where: { tenantId, contactId: contacto.body.id },
      select: { type: true, title: true },
    });
    check(
      'el contacto guarda en su historia la oportunidad y su cambio de etapa',
      actividad.some((x) => x.title.startsWith('Oportunidad creada')) &&
        actividad.some((x) => x.type === 'STAGE_CHANGE'),
      actividad.map((x) => x.type).join(', '),
    );
  } finally {
    const users = await db.user.findMany({
      where: { email: { startsWith: `deals-${run}-` } },
      select: { id: true },
    });
    await db.tenant.deleteMany({ where: { id: { in: tenantIds } } });
    await db.user.deleteMany({ where: { id: { in: users.map((u) => u.id) } } });
    await db.$disconnect();
  }

  summarize('Embudo de ventas verificado de extremo a extremo.');
}

main()
  .catch((error: unknown) => {
    console.error('\nLa prueba no pudo completarse:\n', error);
    process.exitCode = 1;
  })
  .finally(() => process.exit(process.exitCode ?? 0));
