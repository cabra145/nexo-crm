/**
 * Prueba de extremo a extremo del canal de WhatsApp, contra la API y el
 * worker REALES y un SIMULADOR de Meta.
 *
 * El simulador hace de Graph API (la API lo consulta al conectar un número) y
 * de Meta enviando webhooks: firma cada evento con la clave de la app, igual
 * que Meta. Así el CI prueba la conexión, la verificación del webhook, la
 * firma, la idempotencia, el alta de contactos y conversaciones, los estados
 * de entrega y el aislamiento entre empresas sin depender de Meta ni de un
 * número real.
 *
 *   META_GRAPH_URL=http://127.0.0.1:44200 pnpm --filter @nexo/api whatsapp:e2e
 *   (la API tiene que arrancar con ese mismo META_GRAPH_URL)
 */
import { createHash, createHmac } from 'node:crypto';
import { createServer, type Server } from 'node:http';
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
const PASSWORD = 'WhatsApp-Seguro-2026';
const email = (who: string) => `wa-${run}-${who}@nexo.test`;

/** Números de la prueba: únicos por ejecución, en el rango de pruebas. */
const suffix = String(Date.now()).slice(-6);
const NUMBER_A = { phoneNumberId: `1${suffix}01`, display: '+593 99 000 0001' };
const NUMBER_B = { phoneNumberId: `1${suffix}02`, display: '+593 99 000 0002' };
const VALID_TOKEN = `EAAG${'x'.repeat(40)}`;
const SECRET_A = 'a'.repeat(32);
const SECRET_B = 'b'.repeat(32);

/* ========================================================================== */
/*  Simulador de la Graph API                                                   */
/* ========================================================================== */

const KNOWN_NUMBERS = new Map([
  [NUMBER_A.phoneNumberId, { display: NUMBER_A.display, name: 'Ferretería Norte' }],
  [NUMBER_B.phoneNumberId, { display: NUMBER_B.display, name: 'Distribuidora Sur' }],
]);

function startGraphSimulator(): Promise<Server> {
  const url = new URL(process.env.META_GRAPH_URL ?? 'http://127.0.0.1:44200');
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', url).pathname.split('/').filter(Boolean);
    const phoneNumberId = path[1];
    const auth = req.headers.authorization;
    res.setHeader('content-type', 'application/json');
    // Mismas respuestas que Meta: 401 con código 190 para un token malo, 400
    // con 100 para un identificador desconocido.
    if (auth !== `Bearer ${VALID_TOKEN}`) {
      res.statusCode = 401;
      res.end(JSON.stringify({ error: { message: 'Invalid OAuth access token.', code: 190 } }));
      return;
    }
    const known = phoneNumberId ? KNOWN_NUMBERS.get(phoneNumberId) : undefined;
    if (!known) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: { message: 'Unsupported get request.', code: 100 } }));
      return;
    }
    res.end(
      JSON.stringify({
        id: phoneNumberId,
        display_phone_number: known.display,
        verified_name: known.name,
      }),
    );
  });
  return new Promise((resolve) =>
    server.listen(Number(url.port), url.hostname, () => resolve(server)),
  );
}

/* ========================================================================== */
/*  Meta enviando webhooks                                                      */
/* ========================================================================== */

interface InboundOptions {
  phoneNumberId: string;
  from: string;
  name?: string;
  wamid?: string;
  timestamp?: number;
  text?: string;
  image?: { caption?: string };
}

function inboundPayload(o: InboundOptions) {
  const message: Record<string, unknown> = {
    from: o.from,
    id: o.wamid ?? `wamid.${run}.${Math.random().toString(36).slice(2)}`,
    timestamp: String(o.timestamp ?? Math.floor(Date.now() / 1000)),
    type: o.image ? 'image' : 'text',
    ...(o.image
      ? { image: { id: 'media-1', mime_type: 'image/jpeg', ...o.image } }
      : { text: { body: o.text ?? 'Hola' } }),
  };
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'waba-1',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '593990000001', phone_number_id: o.phoneNumberId },
              contacts: [{ wa_id: o.from, profile: { name: o.name ?? 'Cliente' } }],
              messages: [message],
            },
          },
        ],
      },
    ],
  };
}

/**
 * Cada aviso de estado lleva su propio instante, como en Meta. Sin esto, dos
 * avisos iguales en el mismo segundo tendrían el mismo cuerpo, el segundo se
 * descartaría como reenvío y la prueba del orden pasaría sin probar nada
 * (ocurrió: con la protección desactivada seguía en verde).
 */
let statusTick = 0;

function statusPayload(phoneNumberId: string, wamid: string, status: string, extra: object = {}) {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'waba-1',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '593990000001', phone_number_id: phoneNumberId },
              statuses: [
                {
                  id: wamid,
                  status,
                  timestamp: String(Math.floor(Date.now() / 1000) + ++statusTick),
                  recipient_id: '593987000000',
                  ...extra,
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

const sign = (body: string, secret: string) =>
  `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;

/** Envía un webhook como Meta: el cuerpo exacto, firmado. */
async function postWebhook(
  channelId: string,
  payload: unknown,
  secret: string | null,
  rawOverride?: string,
): Promise<{ status: number; body: Record<string, unknown>; raw: string }> {
  const raw = rawOverride ?? JSON.stringify(payload);
  const res = await fetch(`${API}/webhooks/whatsapp/${channelId}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(secret ? { 'x-hub-signature-256': sign(raw, secret) } : {}),
    },
    body: raw,
  });
  const text = await res.text();
  return {
    status: res.status,
    body: text ? (JSON.parse(text) as Record<string, unknown>) : {},
    raw,
  };
}

/* ========================================================================== */

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

interface ChannelBody {
  id: string;
  status: string;
  displayId: string | null;
  verifiedName: string | null;
  webhookUrl: string;
  verifyToken: string;
}

async function main(): Promise<void> {
  const db = new PrismaClient({ datasourceUrl: process.env.DIRECT_DATABASE_URL });
  const graph = await startGraphSimulator();
  console.log(`\nWhatsApp de extremo a extremo · ejecución ${run}`);
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

  /** Espera a que el worker termine con el evento cuyo cuerpo es `raw`. */
  async function processed(raw: string): Promise<string> {
    const eventId = createHash('sha256').update(raw).digest('hex');
    for (let i = 0; i < 60; i++) {
      const event = await db.webhookEvent.findUnique({
        where: { provider_eventId: { provider: 'meta', eventId } },
        select: { status: true },
      });
      if (event && ['PROCESSED', 'IGNORED', 'FAILED'].includes(event.status)) return event.status;
      await new Promise((r) => setTimeout(r, 250));
    }
    return 'TIMEOUT';
  }

  const connect = (s: Session, body: Record<string, unknown>) =>
    http<ChannelBody>('POST', '/channels/whatsapp', { ...as(s), body });

  try {
    /* ---------------------------------------------------------------------- */
    section('1 · Conectar un número');
    const owner = await registerOwner('owner', `WhatsApp ${run}`);
    const tenantId = owner.tenantId;

    const roles = await http<{ roles: Array<{ id: string; key: string }> }>(
      'GET',
      '/team/roles',
      as(owner),
    );
    const agentInvite = await http('POST', '/team/invitations', {
      ...as(owner),
      body: { email: email('agente'), roleId: roles.body.roles.find((r) => r.key === 'AGENT')!.id },
    });
    const agentToken = tokenFrom(await waitForMail(email('agente'), 'te invita'));
    const agent = sessionFrom(
      await http('POST', '/invitations/accept-new', {
        body: { token: agentToken, name: 'Agente', password: PASSWORD },
      }),
    );
    void agentInvite;

    const base = {
      name: 'Ventas',
      phoneNumberId: NUMBER_A.phoneNumberId,
      wabaId: '200000000000001',
      accessToken: VALID_TOKEN,
      appSecret: SECRET_A,
    };

    const byAgent = await connect(agent, base);
    check('un agente no puede conectar canales → 403', byAgent.status === 403, `${byAgent.status}`);

    const badToken = await connect(owner, { ...base, accessToken: `EAAG${'y'.repeat(40)}` });
    check(
      'con un token que Meta rechaza → 400, con el mensaje de Meta',
      badToken.status === 400 &&
        String((badToken.body as unknown as { detail?: string }).detail).includes('Invalid OAuth'),
      `${badToken.status}`,
    );

    const badSecret = await connect(owner, { ...base, appSecret: 'no-es-hex' });
    check('una clave secreta con formato inválido → 400 en su campo', badSecret.status === 400);

    const channel = await connect(owner, base);
    check(
      'con datos válidos → 201, conectado y con el número y el nombre de Meta',
      channel.status === 201 &&
        channel.body.status === 'CONNECTED' &&
        channel.body.displayId === '+593990000001' &&
        channel.body.verifiedName === 'Ferretería Norte',
      `${channel.status} · ${channel.body.displayId}`,
    );
    check(
      'devuelve la URL del webhook y su token de verificación para pegarlos en Meta',
      channel.body.webhookUrl.endsWith(`/api/v1/webhooks/whatsapp/${channel.body.id}`) &&
        channel.body.verifyToken.length >= 24,
    );
    const respuesta =
      JSON.stringify(channel.body) + JSON.stringify(await http('GET', '/channels', as(owner)));
    check(
      'NUNCA devuelve el token de acceso ni la clave secreta',
      !respuesta.includes(VALID_TOKEN) && !respuesta.includes(SECRET_A),
    );
    const stored = await db.channel.findUniqueOrThrow({ where: { id: channel.body.id } });
    check(
      'en la base, las credenciales están cifradas',
      Boolean(stored.credentialsEncrypted) &&
        !stored.credentialsEncrypted!.includes(VALID_TOKEN) &&
        !stored.credentialsEncrypted!.includes(SECRET_A),
    );

    const second = await connect(owner, { ...base, phoneNumberId: NUMBER_B.phoneNumberId });
    check(
      'el plan inicial incluye un canal: el segundo → 403 por límite',
      second.status === 403,
      `${second.status}`,
    );

    const other = await registerOwner('otra', `Otra WhatsApp ${run}`);
    const stolen = await connect(other, { ...base, appSecret: SECRET_B });
    check(
      'el mismo número en otra empresa → 409, sin decir en cuál está',
      stolen.status === 409 && !JSON.stringify(stolen.body).includes(`WhatsApp ${run}`),
      `${stolen.status}`,
    );

    /* ---------------------------------------------------------------------- */
    section('2 · Alta del webhook en Meta (verificación)');
    const verifyUrl = (id: string, token: string, mode = 'subscribe') =>
      `${API}/webhooks/whatsapp/${id}?hub.mode=${mode}&hub.verify_token=${encodeURIComponent(token)}&hub.challenge=reto-${run}`;
    const ok = await fetch(verifyUrl(channel.body.id, channel.body.verifyToken));
    check(
      'con el token correcto responde 200 y devuelve el reto',
      ok.status === 200 && (await ok.text()) === `reto-${run}`,
      `${ok.status}`,
    );
    const wrong = await fetch(verifyUrl(channel.body.id, 'otro-token'));
    check('con otro token → 403', wrong.status === 403, `${wrong.status}`);
    const unknown = await fetch(verifyUrl('00000000-0000-7000-8000-000000000000', 'x'));
    check('un canal que no existe → 404', unknown.status === 404, `${unknown.status}`);

    /* ---------------------------------------------------------------------- */
    section('3 · Firma de los eventos');
    const payload = inboundPayload({
      phoneNumberId: NUMBER_A.phoneNumberId,
      from: '593987000111',
      name: 'María López',
      text: 'Hola, ¿tienen tornillos de 3 pulgadas?',
    });
    const unsigned = await postWebhook(channel.body.id, payload, null);
    const forged = await postWebhook(channel.body.id, payload, 'c'.repeat(32));
    check('sin firma → 401', unsigned.status === 401, `${unsigned.status}`);
    check('firmado con otra clave → 401', forged.status === 401, `${forged.status}`);
    check(
      '…y ninguno de los dos se guardó',
      (await db.webhookEvent.count({ where: { channelId: channel.body.id } })) === 0,
    );

    /* ---------------------------------------------------------------------- */
    section('4 · Mensaje de un número nuevo');
    const first = await postWebhook(channel.body.id, payload, SECRET_A);
    check(
      'un evento firmado → 200 enseguida',
      first.status === 200 && first.body.received === 'nuevo',
      `${first.status}`,
    );
    check('el worker lo procesa', (await processed(first.raw)) === 'PROCESSED');

    const contact = await db.contact.findFirst({
      where: { tenantId, whatsappE164: '+593987000111' },
    });
    check(
      'crea el contacto con su nombre de perfil, su número y sin responsable',
      contact?.firstName === 'María' &&
        contact.lastName === 'López' &&
        contact.phoneE164 === '+593987000111' &&
        contact.source === 'whatsapp' &&
        contact.ownerId === null,
      `${contact?.firstName} ${contact?.lastName}`,
    );
    const conversation = await db.conversation.findFirst({
      where: { tenantId, contactId: contact?.id ?? '' },
    });
    const ventana = conversation?.windowExpiresAt
      ? (conversation.windowExpiresAt.getTime() - Date.now()) / 3_600_000
      : 0;
    check(
      'abre su conversación: abierta, 1 sin leer y la ventana de 24 h en marcha',
      conversation?.status === 'OPEN' &&
        conversation.unreadCount === 1 &&
        ventana > 23.9 &&
        ventana <= 24.01 &&
        conversation.lastMessagePreview === 'Hola, ¿tienen tornillos de 3 pulgadas?',
      `ventana: ${ventana.toFixed(2)} h`,
    );
    const guardado = await db.message.findFirst({ where: { conversationId: conversation?.id } });
    check(
      'guarda el mensaje entrante con su id de Meta',
      guardado?.direction === 'INBOUND' &&
        guardado.type === 'TEXT' &&
        guardado.externalId === payload.entry[0]!.changes[0]!.value.messages[0]!.id,
    );

    /* ---------------------------------------------------------------------- */
    section('5 · Reintentos de Meta: nada se duplica');
    const retry = await postWebhook(channel.body.id, payload, SECRET_A);
    check(
      'el mismo evento otra vez → 200, marcado como repetido',
      retry.status === 200 && retry.body.received === 'repetido',
    );
    // Mismo mensaje (mismo wamid) en un cuerpo distinto: otro evento, mismo mensaje.
    const reformatted = JSON.stringify(payload, null, 2);
    const again = await postWebhook(channel.body.id, payload, SECRET_A, reformatted);
    check(
      'el mismo mensaje en otro cuerpo se procesa…',
      (await processed(again.raw)) === 'PROCESSED',
    );
    check(
      '…pero sigue habiendo un solo mensaje y un solo no leído',
      (await db.message.count({ where: { conversationId: conversation?.id } })) === 1 &&
        (await db.conversation.findUniqueOrThrow({ where: { id: conversation!.id } }))
          .unreadCount === 1,
    );

    /* ---------------------------------------------------------------------- */
    section('6 · Contacto que ya existía, imágenes y mensajes que llegan tarde');
    const existing = await http<{ id: string }>('POST', '/contacts', {
      ...as(owner),
      body: { firstName: 'Carlos', lastName: 'Ya Existía', phoneE164: '+593987000222' },
    });
    const fromExisting = inboundPayload({
      phoneNumberId: NUMBER_A.phoneNumberId,
      from: '593987000222',
      name: 'Otro Nombre',
      image: { caption: 'la pieza que necesito' },
    });
    const imgPost = await postWebhook(channel.body.id, fromExisting, SECRET_A);
    await processed(imgPost.raw);
    const linked = await db.contact.findUniqueOrThrow({ where: { id: existing.body.id } });
    const convExisting = await db.conversation.findFirst({
      where: { contactId: existing.body.id },
    });
    check(
      'un número que ya estaba en el CRM se enlaza a ese contacto, sin crear otro',
      linked.whatsappE164 === '+593987000222' &&
        linked.firstName === 'Carlos' &&
        (await db.contact.count({ where: { tenantId, phoneE164: '+593987000222' } })) === 1,
    );
    check(
      'una imagen con pie de foto se guarda como imagen, con su vista previa',
      convExisting?.lastMessagePreview === 'Imagen: la pieza que necesito',
      convExisting?.lastMessagePreview ?? '',
    );

    const antes = (await db.conversation.findUniqueOrThrow({ where: { id: conversation!.id } }))
      .lastMessageAt;
    const tardio = inboundPayload({
      phoneNumberId: NUMBER_A.phoneNumberId,
      from: '593987000111',
      text: 'Mensaje que llegó con retraso',
      timestamp: Math.floor(Date.now() / 1000) - 3600,
    });
    await processed((await postWebhook(channel.body.id, tardio, SECRET_A)).raw);
    const despues = await db.conversation.findUniqueOrThrow({ where: { id: conversation!.id } });
    check(
      'un mensaje antiguo que llega tarde no mueve el último mensaje ni acorta la ventana',
      despues.lastMessageAt?.getTime() === antes?.getTime() &&
        despues.lastMessagePreview === 'Hola, ¿tienen tornillos de 3 pulgadas?',
    );

    await db.conversation.update({
      where: { id: conversation!.id },
      data: { status: 'RESOLVED', resolvedAt: new Date() },
    });
    await processed(
      (
        await postWebhook(
          channel.body.id,
          inboundPayload({
            phoneNumberId: NUMBER_A.phoneNumberId,
            from: '593987000111',
            text: 'Otra cosa',
          }),
          SECRET_A,
        )
      ).raw,
    );
    const reabierta = await db.conversation.findUniqueOrThrow({ where: { id: conversation!.id } });
    check(
      'si el contacto vuelve a escribir, una conversación resuelta se reabre',
      reabierta.status === 'OPEN' && reabierta.resolvedAt === null,
    );

    /* ---------------------------------------------------------------------- */
    section('7 · Estados de entrega, aunque lleguen desordenados');
    const outbound = await db.message.create({
      data: {
        tenantId,
        conversationId: conversation!.id,
        channelId: channel.body.id,
        direction: 'OUTBOUND',
        type: 'TEXT',
        body: 'Sí, tenemos',
        externalId: `wamid.salida.${run}`,
        status: 'SENT',
      },
    });
    const estado = async (status: string, extra: object = {}) => {
      await processed(
        (
          await postWebhook(
            channel.body.id,
            statusPayload(NUMBER_A.phoneNumberId, outbound.externalId!, status, extra),
            SECRET_A,
          )
        ).raw,
      );
      return (await db.message.findUniqueOrThrow({ where: { id: outbound.id } })).status;
    };
    check('«entregado» → DELIVERED', (await estado('delivered')) === 'DELIVERED');
    check('«leído» → READ', (await estado('read')) === 'READ');
    check(
      'un «entregado» que llega después de «leído» no lo deshace',
      (await estado('delivered')) === 'READ',
    );
    check('un «fallido» tampoco deshace un mensaje ya leído', (await estado('failed')) === 'READ');

    const fallido = await db.message.create({
      data: {
        tenantId,
        conversationId: conversation!.id,
        channelId: channel.body.id,
        direction: 'OUTBOUND',
        type: 'TEXT',
        body: 'Otro',
        externalId: `wamid.fallido.${run}`,
        status: 'SENT',
      },
    });
    await processed(
      (
        await postWebhook(
          channel.body.id,
          statusPayload(NUMBER_A.phoneNumberId, fallido.externalId!, 'failed', {
            errors: [{ code: 131047, title: 'Re-engagement message' }],
          }),
          SECRET_A,
        )
      ).raw,
    );
    const conError = await db.message.findUniqueOrThrow({ where: { id: fallido.id } });
    check(
      'un envío fallido guarda el código y el motivo de Meta',
      conError.status === 'FAILED' &&
        conError.errorCode === '131047' &&
        conError.errorMessage === 'Re-engagement message',
    );

    /* ---------------------------------------------------------------------- */
    section('8 · Eventos que no son de este canal, y aislamiento');
    const intruso = inboundPayload({
      phoneNumberId: NUMBER_B.phoneNumberId,
      from: '593987000999',
      text: 'Evento de otro número',
    });
    const intrusoPost = await postWebhook(channel.body.id, intruso, SECRET_A);
    check(
      'un evento de otro número por la URL de este canal se ignora',
      (await processed(intrusoPost.raw)) === 'IGNORED' &&
        (await db.contact.count({ where: { whatsappE164: '+593987000999' } })) === 0,
    );

    const channelB = await connect(other, {
      ...base,
      name: 'Sur',
      phoneNumberId: NUMBER_B.phoneNumberId,
      appSecret: SECRET_B,
    });
    const paraB = inboundPayload({
      phoneNumberId: NUMBER_B.phoneNumberId,
      from: '593987000333',
      text: 'Hola, empresa B',
    });
    const conFirmaAjena = await postWebhook(channel.body.id, paraB, SECRET_B);
    check(
      'un evento firmado con la clave de OTRA empresa no entra por la URL de ésta → 401',
      conFirmaAjena.status === 401,
    );
    await processed((await postWebhook(channelB.body.id, paraB, SECRET_B)).raw);
    const contactoB = await db.contact.findFirst({ where: { whatsappE164: '+593987000333' } });
    check(
      'el mensaje para la empresa B crea el contacto en B, no en A',
      contactoB?.tenantId === other.tenantId,
    );
    const visiblesA = await http<{ data: Array<{ id: string }> }>(
      'GET',
      '/contacts?q=987000333',
      as(owner),
    );
    check(
      '…y la empresa A no lo encuentra',
      visiblesA.body.data.length === 0,
      `${visiblesA.body.data.length}`,
    );

    /* ---------------------------------------------------------------------- */
    section('9 · Desconectar');
    const desconectado = await http('DELETE', `/channels/${channel.body.id}`, as(owner));
    const trasDesconectar = await postWebhook(channel.body.id, payload, SECRET_A);
    const verificarTras = await fetch(verifyUrl(channel.body.id, channel.body.verifyToken));
    check(
      'desconectar → 204, y el webhook deja de aceptar eventos (404)',
      desconectado.status === 204 && trasDesconectar.status === 404 && verificarTras.status === 404,
      `${desconectado.status} / ${trasDesconectar.status}`,
    );
    const conservado = await db.channel.findUniqueOrThrow({ where: { id: channel.body.id } });
    check(
      '…borra las credenciales pero conserva las conversaciones',
      conservado.credentialsEncrypted === null &&
        (await db.conversation.count({ where: { channelId: channel.body.id } })) >= 2,
    );
    const reconectado = await connect(owner, base);
    check(
      'el número queda libre: se puede volver a conectar',
      reconectado.status === 201,
      `${reconectado.status}`,
    );

    /* ---------------------------------------------------------------------- */
    section('10 · Rastro');
    let acciones: string[] = [];
    for (let i = 0; i < 30 && !['CREATE', 'DELETE'].every((a) => acciones.includes(a)); i++) {
      acciones = (
        await db.auditLog.findMany({
          where: { tenantId, resourceType: 'Channel' },
          select: { action: true },
        })
      ).map((a) => a.action);
      await new Promise((r) => setTimeout(r, 300));
    }
    check(
      'conectar y desconectar quedan auditados',
      acciones.includes('CREATE') && acciones.includes('DELETE'),
      acciones.join(', '),
    );
    const historia = await db.activity.findMany({
      where: { contactId: contact?.id ?? '' },
      select: { title: true },
    });
    check(
      'el contacto guarda en su historia que llegó por WhatsApp',
      historia.some((h) => h.title === 'Contacto creado desde WhatsApp') &&
        historia.some((h) => h.title === 'Escribió por WhatsApp por primera vez'),
    );
  } finally {
    graph.close();
    const users = await db.user.findMany({
      where: { email: { startsWith: `wa-${run}-` } },
      select: { id: true },
    });
    await db.webhookEvent.deleteMany({ where: { tenantId: { in: tenantIds } } });
    await db.tenant.deleteMany({ where: { id: { in: tenantIds } } });
    await db.user.deleteMany({ where: { id: { in: users.map((u) => u.id) } } });
    await db.$disconnect();
  }

  summarize('Canal de WhatsApp verificado de extremo a extremo.');
}

main()
  .catch((error: unknown) => {
    console.error('\nLa prueba no pudo completarse:\n', error);
    process.exitCode = 1;
  })
  .finally(() => process.exit(process.exitCode ?? 0));
