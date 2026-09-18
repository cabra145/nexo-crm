/**
 * Prueba de extremo a extremo de la bandeja de entrada, contra la API y el
 * worker REALES y un SIMULADOR de Meta que también recibe los envíos.
 *
 * Cubre: quién ve qué conversación (sin asignar, asignada, alcance «sólo las
 * suyas»), tomarla a la vez desde dos sesiones, asignar dentro del alcance,
 * responder dentro y fuera de la ventana de 24 h, envío con reintentos y
 * fallos de Meta, el estado que llega ANTES que el id del mensaje, avisos en
 * tiempo real (a quién llegan y a quién no, y el cierre al perder el acceso) y
 * el aislamiento entre empresas.
 *
 * El texto del mensaje dirige al simulador:
 *   «#definitivo»  → Meta lo rechaza (131026, no se reintenta)
 *   «#una-vez»     → rechazado la primera vez, aceptado al reintentarlo a mano
 *   «#temporal»    → Meta da 500 dos veces y luego lo acepta (reintento de la cola)
 *   «#token»       → token inválido (190): el canal lo muestra
 *   «#lento»       → Meta tarda en responder; la prueba envía antes el estado
 *
 *   META_GRAPH_URL=http://127.0.0.1:44200 pnpm --filter @nexo/api inbox:e2e
 */
import { createHmac } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { INBOX_PROBLEMS } from '@nexo/contracts';
import { PrismaClient } from '@nexo/database';
import {
  API,
  check,
  http,
  type HttpResult,
  section,
  summarize,
  tokenFrom,
  waitForMail,
} from './lib/e2e';

const run = Date.now().toString(36);
const PASSWORD = 'Bandeja-Segura-2026';
const email = (who: string) => `inbox-${run}-${who}@nexo.test`;

const suffix = String(Date.now()).slice(-6);
const PHONE_A = `3${suffix}01`;
const PHONE_B = `3${suffix}02`;
const TOKEN = `EAAG${'i'.repeat(40)}`;
const SECRET_A = 'c'.repeat(32);
const SECRET_B = 'e'.repeat(32);
/** Clientes que escriben: dígitos, como los da Meta. */
const CLIENT_1 = `5939${suffix}11`;
const CLIENT_2 = `5939${suffix}22`;
const CLIENT_3 = `5939${suffix}33`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* ========================================================================== */
/*  Simulador de Meta: Graph API (consulta del número y envío)                  */
/* ========================================================================== */

interface SentRequest {
  phoneNumberId: string;
  to: string;
  body: string;
  wamid: string | null;
  status: number;
}

const sent: SentRequest[] = [];
const attemptsByBody = new Map<string, number>();
let wamidSeq = 0;
/** Para «#lento»: se resuelve cuando la prueba ya envió el estado adelantado. */
let releaseSlow: (() => void) | null = null;
let slowArrived: ((wamid: string) => void) | null = null;

const readBody = (req: IncomingMessage) =>
  new Promise<string>((resolve) => {
    let data = '';
    req.on('data', (c: Buffer) => (data += c.toString()));
    req.on('end', () => resolve(data));
  });

function startGraphSimulator(): Promise<Server> {
  const url = new URL(process.env.META_GRAPH_URL ?? 'http://127.0.0.1:44200');
  const server = createServer((req, res) => {
    void (async () => {
      const path = new URL(req.url ?? '/', url).pathname.split('/').filter(Boolean);
      const phoneNumberId = path[1]!;
      res.setHeader('content-type', 'application/json');
      const reply = (status: number, payload: unknown) => {
        res.statusCode = status;
        res.end(JSON.stringify(payload));
      };

      if (req.headers.authorization !== `Bearer ${TOKEN}`) {
        return reply(401, { error: { message: 'Invalid OAuth access token.', code: 190 } });
      }

      if (req.method === 'GET') {
        return reply(200, {
          id: phoneNumberId,
          display_phone_number: phoneNumberId === PHONE_A ? '+593 99 100 0001' : '+593 99 100 0002',
          verified_name: 'Bandeja Prueba',
        });
      }

      const payload = JSON.parse(await readBody(req)) as { to: string; text: { body: string } };
      const body = payload.text.body;
      const attempt = (attemptsByBody.get(body) ?? 0) + 1;
      attemptsByBody.set(body, attempt);
      const record = (status: number, wamid: string | null) =>
        sent.push({ phoneNumberId, to: payload.to, body, wamid, status });

      if (body.includes('#definitivo') || (body.includes('#una-vez') && attempt === 1)) {
        record(400, null);
        return reply(400, {
          error: {
            message: 'Message undeliverable.',
            code: 131026,
            error_data: { details: 'El destinatario no puede recibir este mensaje.' },
          },
        });
      }
      if (body.includes('#temporal') && attempt <= 2) {
        record(500, null);
        return reply(500, { error: { message: 'Service temporarily unavailable', code: 2 } });
      }
      if (body.includes('#token')) {
        record(401, null);
        return reply(401, {
          error: { message: 'Error validating access token: Session has expired.', code: 190 },
        });
      }

      const wamid = `wamid.${run}.${++wamidSeq}`;
      if (body.includes('#lento')) {
        // Meta avisa del estado antes de haber respondido al envío.
        const released = new Promise<void>((r) => (releaseSlow = r));
        slowArrived?.(wamid);
        await released;
      }
      record(200, wamid);
      reply(200, {
        messaging_product: 'whatsapp',
        contacts: [{ input: payload.to, wa_id: payload.to }],
        messages: [{ id: wamid }],
      });
    })();
  });
  return new Promise((resolve) =>
    server.listen(Number(url.port), url.hostname, () => resolve(server)),
  );
}

/* ========================================================================== */
/*  Meta enviando webhooks                                                      */
/* ========================================================================== */

let tick = 0;
const envelope = (phoneNumberId: string, value: object) => ({
  object: 'whatsapp_business_account',
  entry: [
    {
      id: 'waba-1',
      changes: [
        {
          field: 'messages',
          value: {
            messaging_product: 'whatsapp',
            metadata: { display_phone_number: '593991000001', phone_number_id: phoneNumberId },
            ...value,
          },
        },
      ],
    },
  ],
});

const inbound = (phoneNumberId: string, from: string, text: string) =>
  envelope(phoneNumberId, {
    contacts: [{ wa_id: from, profile: { name: `Cliente ${from.slice(-2)}` } }],
    messages: [
      {
        from,
        id: `wamid.in.${run}.${++tick}`,
        timestamp: String(Math.floor(Date.now() / 1000)),
        type: 'text',
        text: { body: text },
      },
    ],
  });

const deliveryStatus = (phoneNumberId: string, wamid: string, status: string) =>
  envelope(phoneNumberId, {
    statuses: [
      {
        id: wamid,
        status,
        timestamp: String(Math.floor(Date.now() / 1000) + ++tick),
        recipient_id: CLIENT_1,
      },
    ],
  });

async function postWebhook(channelId: string, payload: unknown, secret: string): Promise<number> {
  const raw = JSON.stringify(payload);
  const res = await fetch(`${API}/webhooks/whatsapp/${channelId}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-hub-signature-256': `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`,
    },
    body: raw,
  });
  await res.text();
  return res.status;
}

/* ========================================================================== */
/*  Cliente SSE                                                                 */
/* ========================================================================== */

interface StreamEvent {
  event: string;
  data: {
    conversationId?: string;
    reason?: string;
    assigneeId?: string | null;
  };
}

interface Stream {
  events: StreamEvent[];
  closed: boolean;
  status: number;
  close: () => void;
  waitFor: (predicate: (e: StreamEvent) => boolean, timeoutMs?: number) => Promise<boolean>;
}

async function openStream(token: string): Promise<Stream> {
  const controller = new AbortController();
  const res = await fetch(`${API}/realtime/stream`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream' },
    signal: controller.signal,
  });
  const stream: Stream = {
    events: [],
    closed: false,
    status: res.status,
    close: () => controller.abort(),
    async waitFor(predicate, timeoutMs = 8_000) {
      const until = Date.now() + timeoutMs;
      while (Date.now() < until) {
        if (stream.events.some(predicate)) return true;
        await sleep(50);
      }
      return false;
    },
  };
  if (!res.ok || !res.body) {
    stream.closed = true;
    return stream;
  }
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  void (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let index: number;
        while ((index = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          const event = /^event: (.*)$/m.exec(block)?.[1];
          const data = /^data: (.*)$/m.exec(block)?.[1];
          if (event && data) {
            stream.events.push({ event, data: JSON.parse(data) as StreamEvent['data'] });
          }
        }
      }
    } catch {
      // Cerrada por la prueba (abort).
    }
    stream.closed = true;
  })();
  await stream.waitFor((e) => e.event === 'ready', 5_000);
  return stream;
}

/* ========================================================================== */

interface Session {
  accessToken: string;
  userId: string;
  tenantId: string;
  membershipId: string;
}
const as = (s: Session) => ({ token: s.accessToken });
const sessionFrom = (res: HttpResult): Session => {
  const body = res.body as {
    accessToken: string;
    user: { id: string };
    activeTenant: { tenantId: string; membershipId: string };
  };
  return {
    accessToken: body.accessToken,
    userId: body.user.id,
    tenantId: body.activeTenant.tenantId,
    membershipId: body.activeTenant.membershipId,
  };
};

interface Conversation {
  id: string;
  status: string;
  unreadCount: number;
  assignee: { id: string } | null;
  contact: { phone: string | null };
  can?: { reply: boolean; take: boolean; assign: boolean };
}
interface ListBody {
  data: Conversation[];
  unread: { mine: number; unassigned: number; all: number };
}
interface MessageBody {
  id: string;
  direction: string;
  body: string | null;
  status: string;
  errorMessage: string | null;
}

async function main(): Promise<void> {
  const db = new PrismaClient({ datasourceUrl: process.env.DIRECT_DATABASE_URL });
  const graph = await startGraphSimulator();
  console.log(`\nBandeja de entrada de extremo a extremo · ejecución ${run}`);
  const tenantIds: string[] = [];
  const streams: Stream[] = [];

  async function registerOwner(who: string, company: string): Promise<Session> {
    await http('POST', '/auth/register', {
      body: { name: `Dueña ${who}`, email: email(who), password: PASSWORD, companyName: company },
    });
    await http('POST', '/auth/verify-email', {
      body: { token: tokenFrom(await waitForMail(email(who), 'Confirma tu correo')) },
    });
    const session = sessionFrom(
      await http('POST', '/auth/login', { body: { email: email(who), password: PASSWORD } }),
    );
    tenantIds.push(session.tenantId);
    return session;
  }

  async function member(owner: Session, who: string, roleId: string): Promise<Session> {
    await http('POST', '/team/invitations', { ...as(owner), body: { email: email(who), roleId } });
    const token = tokenFrom(await waitForMail(email(who), 'te invita'));
    const res = await http('POST', '/invitations/accept-new', {
      body: { token, name: `Persona ${who}`, password: PASSWORD },
    });
    if (res.status !== 200) throw new Error(`accept-new ${who} → ${res.status}`);
    return sessionFrom(res);
  }

  const list = (s: Session, query = '') => http<ListBody>('GET', `/conversations${query}`, as(s));
  const messagesOf = (s: Session, id: string, query = '') =>
    http<{ data: MessageBody[]; hasMore: boolean }>(
      'GET',
      `/conversations/${id}/messages${query}`,
      as(s),
    );
  const sendText = (s: Session, id: string, body: string) =>
    http<MessageBody>('POST', `/conversations/${id}/messages`, { ...as(s), body: { body } });
  const assign = (s: Session, id: string, userId: string | null) =>
    http<Conversation>('POST', `/conversations/${id}/assign`, { ...as(s), body: { userId } });

  /** Espera a que un mensaje llegue a un estado (lo escribe el worker). */
  async function messageStatus(id: string, wanted: string[], timeoutMs = 15_000) {
    const until = Date.now() + timeoutMs;
    let row: { status: string; errorMessage: string | null; externalId: string | null } | null =
      null;
    while (Date.now() < until) {
      row = await db.message.findUnique({
        where: { id },
        select: { status: true, errorMessage: true, externalId: true },
      });
      if (row && wanted.includes(row.status)) return row;
      await sleep(150);
    }
    return row;
  }

  /** Espera a que el worker cree la conversación del cliente. */
  async function conversationOf(tenantId: string, phone: string): Promise<string | null> {
    for (let i = 0; i < 60; i++) {
      const row = await db.conversation.findFirst({
        where: { tenantId, contact: { whatsappE164: `+${phone}` } },
        select: { id: true },
      });
      if (row) return row.id;
      await sleep(200);
    }
    return null;
  }

  try {
    /* ---------------------------------------------------------------------- */
    section('1 · Preparación: empresa, equipo y número conectado');
    const owner = await registerOwner('owner', `Bandeja ${run}`);
    const tenantId = owner.tenantId;
    const pro = await db.plan.findUniqueOrThrow({ where: { code: 'pro' } });
    await db.subscription.update({ where: { tenantId }, data: { planId: pro.id } });

    const roles = await http<{ roles: Array<{ id: string; key: string }> }>(
      'GET',
      '/team/roles',
      as(owner),
    );
    const roleId = (key: string) => roles.body.roles.find((r) => r.key === key)!.id;
    const limitedRole = await http<{ id: string }>('POST', '/team/roles', {
      ...as(owner),
      body: {
        name: 'Atención limitada',
        permissions: { 'conversation:read': 'OWN', 'conversation:write': 'OWN' },
      },
    });
    check(
      'rol personalizado «sólo las suyas»',
      limitedRole.status === 201,
      `${limitedRole.status}`,
    );

    const ana = await member(owner, 'ana', roleId('AGENT'));
    const beto = await member(owner, 'beto', roleId('AGENT'));
    const carla = await member(owner, 'carla', limitedRole.body.id);
    const visor = await member(owner, 'visor', roleId('VIEWER'));

    const channel = await http<{ id: string }>('POST', '/channels/whatsapp', {
      ...as(owner),
      body: {
        name: 'Ventas',
        phoneNumberId: PHONE_A,
        wabaId: '200000000000009',
        accessToken: TOKEN,
        appSecret: SECRET_A,
      },
    });
    check('número conectado', channel.status === 201, `${channel.status}`);
    const channelId = channel.body.id;

    /* ---------------------------------------------------------------------- */
    section('2 · Tiempo real: conexión y permisos');
    const anaStream = await openStream(ana.accessToken);
    const carlaStream = await openStream(carla.accessToken);
    streams.push(anaStream, carlaStream);
    check('el agente abre el canal de avisos', anaStream.status === 200 && !anaStream.closed);
    const visorStream = await openStream(visor.accessToken);
    check(
      'quien no puede ver conversaciones no abre el canal → 403',
      visorStream.status === 403,
      `${visorStream.status}`,
    );
    const noToken = await fetch(`${API}/realtime/stream`);
    await noToken.text();
    check('sin sesión → 401', noToken.status === 401, `${noToken.status}`);

    /* ---------------------------------------------------------------------- */
    section('3 · Una conversación nueva llega sin asignar');
    await postWebhook(channelId, inbound(PHONE_A, CLIENT_1, 'Hola, ¿tienen taladros?'), SECRET_A);
    const convId = await conversationOf(tenantId, CLIENT_1);
    check('el worker crea la conversación', convId !== null);
    const c1 = convId!;

    check(
      'el aviso llega al agente en tiempo real',
      await anaStream.waitFor((e) => e.data.conversationId === c1 && e.data.reason === 'message'),
    );
    check(
      '…y a quien sólo ve las suyas, porque está sin asignar',
      await carlaStream.waitFor((e) => e.data.conversationId === c1),
    );

    const ownerList = await list(owner, '?view=unassigned');
    const row = ownerList.body.data.find((c) => c.id === c1);
    check(
      'aparece en «sin asignar», con 1 sin leer',
      row?.unreadCount === 1 && row.assignee === null && ownerList.body.unread.unassigned >= 1,
      JSON.stringify(ownerList.body.unread),
    );
    const carlaList = await list(carla);
    check(
      'quien sólo ve las suyas la ve mientras nadie la toma',
      carlaList.body.data.some((c) => c.id === c1),
    );
    const byVisor = await list(visor);
    check('el invitado no ve la bandeja → 403', byVisor.status === 403, `${byVisor.status}`);

    /* ---------------------------------------------------------------------- */
    section('4 · Tomarla: dos a la vez, sólo uno lo consigue');
    const [takeA, takeB] = await Promise.all([
      assign(ana, c1, ana.userId),
      assign(beto, c1, beto.userId),
    ]);
    const statuses = [takeA.status, takeB.status].sort();
    const loser = takeA.status === 409 ? takeA : takeB;
    check(
      'una 200 y otra 409 «ya la tomó otra persona»',
      statuses[0] === 200 &&
        statuses[1] === 409 &&
        loser.body &&
        (loser.body as unknown as { type: string }).type === INBOX_PROBLEMS.ALREADY_ASSIGNED,
      statuses.join(','),
    );
    const winner = takeA.status === 200 ? ana : beto;
    const other = winner === ana ? beto : ana;
    const assignedTo = await db.conversation.findUniqueOrThrow({
      where: { id: c1 },
      select: { assigneeId: true },
    });
    check('queda asignada a quien ganó', assignedTo.assigneeId === winner.userId);

    // A partir de aquí, que la tenga Ana (el resto de la prueba lo asume).
    if (winner !== ana) {
      const moved = await assign(owner, c1, ana.userId);
      check('la dueña se la pasa a Ana', moved.status === 200, `${moved.status}`);
    }

    check(
      'quien sólo ve las suyas recibe el aviso de que ya no es suya',
      await carlaStream.waitFor(
        (e) => e.data.conversationId === c1 && e.data.reason === 'assignment',
      ),
    );
    const carlaAfter = await list(carla);
    const carlaGet = await http('GET', `/conversations/${c1}`, as(carla));
    check(
      '…y deja de verla: fuera de su lista y 404 al abrirla',
      !carlaAfter.body.data.some((c) => c.id === c1) && carlaGet.status === 404,
      `${carlaGet.status}`,
    );
    const carlaSend = await sendText(carla, c1, 'Hola');
    check('tampoco puede responderla → 404', carlaSend.status === 404, `${carlaSend.status}`);

    const steal = await assign(other, c1, other.userId);
    check('un agente no se queda la de otro → 409', steal.status === 409, `${steal.status}`);
    const toCarla = await assign(other, c1, carla.userId);
    check(
      'un agente no puede asignar a otros (sin «asignar») → 403',
      toCarla.status === 403,
      `${toCarla.status}`,
    );

    /* ---------------------------------------------------------------------- */
    section('5 · Responder: cola, envío a Meta y estados');
    const carlaEventsBefore = carlaStream.events.length;
    const reply = await sendText(ana, c1, 'Sí, tenemos varios modelos.');
    check(
      'la respuesta se acepta al momento en cola (QUEUED)',
      reply.status === 201 && reply.body.status === 'QUEUED',
      `${reply.status} ${reply.body.status}`,
    );
    const afterSend = await messageStatus(reply.body.id, ['SENT', 'FAILED']);
    check('el worker la envía a Meta → SENT', afterSend?.status === 'SENT', afterSend?.status);
    const request = sent.find((r) => r.body === 'Sí, tenemos varios modelos.');
    check(
      'a Meta le llega el número sin «+» desde el número del canal',
      request?.to === CLIENT_1 && request.phoneNumberId === PHONE_A,
      JSON.stringify(request),
    );
    check('se guarda el id de Meta del mensaje', afterSend?.externalId === request?.wamid);
    check(
      'el aviso de entrega llega a quien la lleva',
      await anaStream.waitFor((e) => e.data.conversationId === c1 && e.data.reason === 'delivery'),
    );

    await postWebhook(channelId, deliveryStatus(PHONE_A, request!.wamid!, 'delivered'), SECRET_A);
    await postWebhook(channelId, deliveryStatus(PHONE_A, request!.wamid!, 'read'), SECRET_A);
    const read = await messageStatus(reply.body.id, ['READ']);
    check('los avisos de Meta lo llevan a «leído»', read?.status === 'READ', read?.status);
    await sleep(500);
    check(
      'nada de esto le llega a quien ya no la ve',
      !carlaStream.events.slice(carlaEventsBefore).some((e) => e.data.conversationId === c1),
    );

    const detail = await http<Conversation>('GET', `/conversations/${c1}`, as(ana));
    check(
      'responder la marca leída',
      detail.body.unreadCount === 0 && detail.body.can?.reply === true,
    );

    /* ---------------------------------------------------------------------- */
    section('6 · Fallos de Meta');
    const final = await sendText(ana, c1, 'Te paso el catálogo #definitivo');
    const finalRow = await messageStatus(final.body.id, ['FAILED', 'SENT']);
    check(
      'un rechazo definitivo → FAILED con el motivo de Meta, sin reintentos',
      finalRow?.status === 'FAILED' &&
        (finalRow.errorMessage ?? '').includes('no puede recibir') &&
        attemptsByBody.get('Te paso el catálogo #definitivo') === 1,
      `${finalRow?.status} · intentos ${attemptsByBody.get('Te paso el catálogo #definitivo')}`,
    );

    const temporary = await sendText(ana, c1, 'Confirmo el pedido #temporal');
    const temporaryRow = await messageStatus(temporary.body.id, ['SENT', 'FAILED'], 30_000);
    check(
      'un fallo temporal se reintenta solo hasta enviarlo',
      temporaryRow?.status === 'SENT' && attemptsByBody.get('Confirmo el pedido #temporal') === 3,
      `${temporaryRow?.status} · intentos ${attemptsByBody.get('Confirmo el pedido #temporal')}`,
    );

    const once = await sendText(ana, c1, 'Precio especial #una-vez');
    await messageStatus(once.body.id, ['FAILED']);
    const retried = await http(
      'POST',
      `/conversations/${c1}/messages/${once.body.id}/retry`,
      as(ana),
    );
    const onceRow = await messageStatus(once.body.id, ['SENT']);
    check(
      'reintentar a mano un fallido lo envía',
      retried.status === 204 && onceRow?.status === 'SENT',
      `${retried.status} ${onceRow?.status}`,
    );
    const retrySent = await http(
      'POST',
      `/conversations/${c1}/messages/${once.body.id}/retry`,
      as(ana),
    );
    check('reintentar uno ya enviado → 409', retrySent.status === 409, `${retrySent.status}`);

    const expired = await sendText(ana, c1, 'Aviso #token');
    const expiredRow = await messageStatus(expired.body.id, ['FAILED']);
    const channels = await http<Array<{ id: string; lastErrorMessage: string | null }>>(
      'GET',
      '/channels',
      as(owner),
    );
    check(
      'token caducado → FAILED y el canal muestra el error',
      expiredRow?.status === 'FAILED' &&
        (channels.body.find((c) => c.id === channelId)?.lastErrorMessage ?? '').includes(
          'Session has expired',
        ),
    );

    /* ---------------------------------------------------------------------- */
    section('7 · El estado llega antes que el id del mensaje');
    const arrived = new Promise<string>((r) => (slowArrived = r));
    const slow = await sendText(ana, c1, 'Un momento #lento');
    const slowWamid = await arrived;
    // Meta avisa «entregado» mientras el envío aún no ha respondido.
    await postWebhook(channelId, deliveryStatus(PHONE_A, slowWamid, 'delivered'), SECRET_A);
    await sleep(800);
    releaseSlow?.();
    const slowRow = await messageStatus(slow.body.id, ['DELIVERED'], 30_000);
    check(
      'el estado adelantado no se pierde: termina en DELIVERED',
      slowRow?.status === 'DELIVERED',
      slowRow?.status,
    );

    /* ---------------------------------------------------------------------- */
    section('8 · Ventana de 24 h');
    await db.conversation.update({
      where: { id: c1 },
      data: { windowExpiresAt: new Date(Date.now() - 60_000) },
    });
    const sentBefore = sent.length;
    const late = await sendText(ana, c1, 'Hola de nuevo');
    check(
      'fuera de la ventana → 409 y no se envía nada',
      late.status === 409 &&
        (late.body as unknown as { type: string }).type === INBOX_PROBLEMS.WINDOW_CLOSED &&
        sent.length === sentBefore,
      `${late.status}`,
    );
    const closedDetail = await http<{ windowExpiresAt: string }>(
      'GET',
      `/conversations/${c1}`,
      as(ana),
    );
    check(
      'la conversación dice cuándo cerró la ventana',
      new Date(closedDetail.body.windowExpiresAt).getTime() < Date.now(),
    );
    await postWebhook(channelId, inbound(PHONE_A, CLIENT_1, '¿Siguen ahí?'), SECRET_A);
    let reopened = 0;
    for (let i = 0; i < 40 && reopened !== 201; i++) {
      await sleep(250);
      const again = await sendText(ana, c1, 'Sí, aquí estamos.');
      reopened = again.status;
    }
    check('cuando el cliente vuelve a escribir, se puede responder', reopened === 201);

    /* ---------------------------------------------------------------------- */
    section('9 · Mensajes paginados, leídos y resolver');
    const page1 = await messagesOf(ana, c1, '?limit=3');
    const page2 = await messagesOf(ana, c1, `?limit=3&before=${page1.body.data[0]!.id}`);
    const idsInOrder = [...page2.body.data, ...page1.body.data].map((m) => m.id);
    check(
      'de 3 en 3 hacia atrás, en orden y sin repetir',
      page1.body.data.length === 3 &&
        page1.body.hasMore &&
        page2.body.data.length === 3 &&
        new Set(idsInOrder).size === 6,
    );
    check(
      'el primer mensaje es el del cliente',
      (await messagesOf(ana, c1, '?limit=100')).body.data[0]?.body === 'Hola, ¿tienen taladros?',
    );

    await postWebhook(channelId, inbound(PHONE_A, CLIENT_1, 'Gracias'), SECRET_A);
    let unread = 0;
    for (let i = 0; i < 40 && unread === 0; i++) {
      await sleep(200);
      unread = (await http<Conversation>('GET', `/conversations/${c1}`, as(ana))).body.unreadCount;
    }
    const marked = await http('POST', `/conversations/${c1}/read`, as(ana));
    const afterRead = await http<Conversation>('GET', `/conversations/${c1}`, as(ana));
    check(
      'marcar como leída pone a cero los no leídos',
      unread === 1 && marked.status === 204 && afterRead.body.unreadCount === 0,
      `${unread} → ${afterRead.body.unreadCount}`,
    );

    const resolved = await http<Conversation>('POST', `/conversations/${c1}/status`, {
      ...as(ana),
      body: { status: 'RESOLVED' },
    });
    const openList = await list(ana, '?view=mine');
    const resolvedList = await list(ana, '?view=mine&state=resolved');
    check(
      'resolverla la saca de las abiertas',
      resolved.body.status === 'RESOLVED' &&
        !openList.body.data.some((c) => c.id === c1) &&
        resolvedList.body.data.some((c) => c.id === c1),
    );

    /* ---------------------------------------------------------------------- */
    section('10 · Asignar dentro del alcance');
    await postWebhook(channelId, inbound(PHONE_A, CLIENT_2, 'Buenas tardes'), SECRET_A);
    const c2 = (await conversationOf(tenantId, CLIENT_2))!;
    const toLimited = await assign(owner, c2, carla.userId);
    check(
      'la dueña la asigna a quien sólo ve las suyas',
      toLimited.status === 200 && toLimited.body.assignee?.id === carla.userId,
      `${toLimited.status}`,
    );
    check(
      '…y a ella le llega el aviso',
      await carlaStream.waitFor(
        (e) => e.data.conversationId === c2 && e.data.assigneeId === carla.userId,
      ),
    );
    const carlaReply = await sendText(carla, c2, 'Hola, te atiendo yo.');
    check('ahora sí puede responderla', carlaReply.status === 201, `${carlaReply.status}`);
    const toVisor = await assign(owner, c2, visor.userId);
    check(
      'no se asigna a quien no puede ver conversaciones → 400',
      toVisor.status === 400,
      `${toVisor.status}`,
    );
    const release = await assign(carla, c2, null);
    check('quien la lleva la puede liberar', release.status === 200, `${release.status}`);

    // Responder a una sin asignar la toma.
    await postWebhook(channelId, inbound(PHONE_A, CLIENT_3, 'Quiero una cotización'), SECRET_A);
    const c3 = (await conversationOf(tenantId, CLIENT_3))!;
    const firstReply = await sendText(beto, c3, 'Con gusto.');
    const c3Row = await db.conversation.findUniqueOrThrow({
      where: { id: c3 },
      select: { assigneeId: true },
    });
    check(
      'responder a una sin asignar la toma',
      firstReply.status === 201 && c3Row.assigneeId === beto.userId,
    );

    /* ---------------------------------------------------------------------- */
    section('11 · Aislamiento entre empresas');
    const rival = await registerOwner('rival', `Rival ${run}`);
    const rivalStream = await openStream(rival.accessToken);
    streams.push(rivalStream);
    const rivalGet = await http('GET', `/conversations/${c1}`, as(rival));
    const rivalSend = await sendText(rival, c1, 'Hola');
    const rivalAssign = await assign(rival, c1, rival.userId);
    const rivalList = await list(rival);
    check(
      'otra empresa no la ve, ni la responde, ni la toma (404)',
      rivalGet.status === 404 &&
        rivalSend.status === 404 &&
        rivalAssign.status === 404 &&
        rivalList.body.data.length === 0,
      `${rivalGet.status} ${rivalSend.status} ${rivalAssign.status}`,
    );
    const rivalChannel = await http<{ id: string }>('POST', '/channels/whatsapp', {
      ...as(rival),
      body: {
        name: 'Rival',
        phoneNumberId: PHONE_B,
        wabaId: '200000000000010',
        accessToken: TOKEN,
        appSecret: SECRET_B,
      },
    });
    await postWebhook(rivalChannel.body.id, inbound(PHONE_B, CLIENT_1, 'Hola rival'), SECRET_B);
    const rivalConv = await conversationOf(rival.tenantId, CLIENT_1);
    check(
      'el mismo cliente en otra empresa es otra conversación, y su aviso sólo llega allí',
      rivalConv !== null &&
        rivalConv !== c1 &&
        (await rivalStream.waitFor((e) => e.data.conversationId === rivalConv)),
    );
    await sleep(500);
    check(
      'ningún aviso de una empresa llega a la otra',
      !anaStream.events.some((e) => e.data.conversationId === rivalConv) &&
        !rivalStream.events.some((e) => [c1, c2, c3].includes(e.data.conversationId ?? '')),
    );

    /* ---------------------------------------------------------------------- */
    section('12 · Perder el acceso cierra el canal de avisos');
    const disabled = await http('POST', `/team/members/${carla.membershipId}/disable`, as(owner));
    check('la dueña desactiva a Carla', disabled.status === 204 || disabled.status === 200);
    await postWebhook(channelId, inbound(PHONE_A, CLIENT_2, '¿Hola?'), SECRET_A);
    let closed = false;
    for (let i = 0; i < 60 && !closed; i++) {
      await sleep(200);
      closed = carlaStream.closed;
    }
    check('su conexión se cierra con el siguiente aviso', closed);
    const reopen = await fetch(`${API}/realtime/stream`, {
      headers: { Authorization: `Bearer ${carla.accessToken}` },
    });
    await reopen.body?.cancel();
    check(
      '…y no puede volver a abrirla con el mismo token → 401',
      reopen.status === 401,
      `${reopen.status}`,
    );
  } finally {
    for (const stream of streams) stream.close();
    await db.tenant.deleteMany({ where: { id: { in: tenantIds } } }).catch(() => undefined);
    await db.$disconnect();
    await new Promise((resolve) => graph.close(resolve));
  }

  summarize('Bandeja de entrada de extremo a extremo superada.');
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
