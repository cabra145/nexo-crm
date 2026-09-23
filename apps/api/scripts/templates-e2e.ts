/**
 * Prueba de extremo a extremo de las plantillas de WhatsApp, contra la API y
 * el worker REALES y un simulador de Meta.
 *
 * Cubre: sincronizar (y volver a sincronizar sin duplicar), qué plantillas se
 * pueden enviar y cuáles no y por qué, el cambio de estado que Meta envía por
 * el webhook, el envío FUERA de la ventana de 24 h —lo único que Meta
 * permite—, la validación de variables, lo que recibe Meta de verdad y el
 * aislamiento entre empresas.
 *
 *   META_GRAPH_URL=http://127.0.0.1:44200 pnpm --filter @nexo/api templates:e2e
 */
import { createHmac } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { INBOX_PROBLEMS, TEMPLATE_PROBLEMS, type TemplateView } from '@nexo/contracts';
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
const PASSWORD = 'Plantillas-Seguras-2026';
const email = (who: string) => `tpl-${run}-${who}@nexo.test`;
const suffix = String(Date.now()).slice(-6);
const PHONE_A = `6${suffix}01`;
const PHONE_A2 = `6${suffix}03`;
const PHONE_B = `6${suffix}02`;
const WABA_A = `700000000000${suffix.slice(-3)}`;
const WABA_A2 = `900000000000${suffix.slice(-3)}`;
const WABA_B = `800000000000${suffix.slice(-3)}`;
const TOKEN = `EAAG${'t'.repeat(40)}`;
const SECRET_A = '3'.repeat(32);
const SECRET_B = '4'.repeat(32);
const CLIENT = `5939${suffix}77`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* ========================================================================== */
/*  Simulador de Meta                                                          */
/* ========================================================================== */

/** Plantillas que «tiene» cada cuenta de WhatsApp Business. */
const catalogue = new Map<string, Array<Record<string, unknown>>>();
const outbound: Array<Record<string, unknown>> = [];

const bodyComponent = (text: string) => ({ type: 'BODY', text });

function startMeta(): Promise<Server> {
  const base = new URL(process.env.META_GRAPH_URL ?? 'http://127.0.0.1:44200');
  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', base);
      const parts = url.pathname.split('/').filter(Boolean);
      const json = (status: number, body: unknown) => {
        res.statusCode = status;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(body));
      };
      if (req.headers.authorization !== `Bearer ${TOKEN}`) {
        return json(401, { error: { message: 'Invalid OAuth access token.', code: 190 } });
      }

      // Envío de mensajes.
      if (req.method === 'POST' && parts[2] === 'messages') {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        outbound.push(JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>);
        return json(200, { messages: [{ id: `wamid.tpl.${outbound.length}` }] });
      }

      // Plantillas de una cuenta: GET /{waba-id}/message_templates
      if (parts[2] === 'message_templates') {
        const waba = parts[1]!;
        return json(200, { data: catalogue.get(waba) ?? [] });
      }

      // Alta del número.
      const id = parts[1]!;
      return json(200, {
        id,
        display_phone_number: id === PHONE_A ? '+593 99 300 0001' : '+593 99 300 0002',
        verified_name: 'Plantillas Prueba',
      });
    })();
  });
  return new Promise((resolve) =>
    server.listen(Number(base.port), base.hostname, () => resolve(server)),
  );
}

/* ========================================================================== */

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

let tick = 0;
const inboundText = (phoneNumberId: string, text: string) => ({
  object: 'whatsapp_business_account',
  entry: [
    {
      id: 'waba',
      changes: [
        {
          field: 'messages',
          value: {
            messaging_product: 'whatsapp',
            metadata: { display_phone_number: '593993000001', phone_number_id: phoneNumberId },
            contacts: [{ wa_id: CLIENT, profile: { name: 'Cliente Plantillas' } }],
            messages: [
              {
                from: CLIENT,
                id: `wamid.in.tpl.${run}.${++tick}`,
                timestamp: String(Math.floor(Date.now() / 1000)),
                type: 'text',
                text: { body: text },
              },
            ],
          },
        },
      ],
    },
  ],
});

/** El aviso de Meta cuando cambia el estado de una plantilla. */
const templateStatusEvent = (
  phoneNumberId: string,
  template: { id?: string; name?: string; language?: string },
  event: string,
  reason?: string,
) => ({
  object: 'whatsapp_business_account',
  entry: [
    {
      id: 'waba',
      changes: [
        {
          field: 'message_template_status_update',
          value: {
            metadata: { display_phone_number: '593993000001', phone_number_id: phoneNumberId },
            event,
            ...(template.id ? { message_template_id: template.id } : {}),
            ...(template.name ? { message_template_name: template.name } : {}),
            ...(template.language ? { message_template_language: template.language } : {}),
            ...(reason ? { reason } : {}),
          },
        },
      ],
    },
  ],
});

interface Session {
  accessToken: string;
  tenantId: string;
}
const sessionFrom = (res: HttpResult): Session => {
  const body = res.body as { accessToken: string; activeTenant: { tenantId: string } };
  return { accessToken: body.accessToken, tenantId: body.activeTenant.tenantId };
};

async function main(): Promise<void> {
  const db = new PrismaClient({ datasourceUrl: process.env.DIRECT_DATABASE_URL });
  const meta = await startMeta();
  const tenantIds: string[] = [];
  console.log(`\nPlantillas de WhatsApp de extremo a extremo · ejecución ${run}`);

  // Lo que «tiene» cada cuenta en Meta.
  catalogue.set(WABA_A, [
    {
      id: 'meta-tpl-1',
      name: 'recordatorio_cita',
      language: 'es',
      category: 'UTILITY',
      status: 'APPROVED',
      components: [bodyComponent('Hola {{1}}, te recordamos tu cita del {{2}}.')],
    },
    {
      id: 'meta-tpl-2',
      name: 'bienvenida',
      language: 'es',
      category: 'MARKETING',
      status: 'APPROVED',
      components: [bodyComponent('¡Gracias por escribirnos!')],
    },
    {
      id: 'meta-tpl-3',
      name: 'en_revision',
      language: 'es',
      category: 'UTILITY',
      status: 'PENDING',
      components: [bodyComponent('Pendiente de aprobación {{1}}')],
    },
    {
      id: 'meta-tpl-4',
      name: 'con_imagen',
      language: 'es',
      category: 'MARKETING',
      status: 'APPROVED',
      components: [
        { type: 'HEADER', format: 'IMAGE' },
        bodyComponent('Mira nuestra promoción {{1}}'),
      ],
    },
    {
      id: 'meta-tpl-5',
      name: 'rechazada',
      language: 'es',
      category: 'MARKETING',
      status: 'REJECTED',
      rejected_reason: 'INVALID_FORMAT',
      components: [bodyComponent('Texto rechazado')],
    },
  ]);
  catalogue.set(WABA_B, [
    {
      id: 'meta-tpl-b1',
      name: 'solo_de_b',
      language: 'es',
      category: 'UTILITY',
      status: 'APPROVED',
      components: [bodyComponent('Plantilla de la otra empresa')],
    },
  ]);

  async function registerOwner(who: string): Promise<Session> {
    await http('POST', '/auth/register', {
      body: {
        name: `Dueña ${who}`,
        email: email(who),
        password: PASSWORD,
        companyName: `Plantillas ${who} ${run}`,
      },
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

  const connect = async (s: Session, phoneNumberId: string, wabaId: string, appSecret: string) => {
    const res = await http<{ id: string }>('POST', '/channels/whatsapp', {
      token: s.accessToken,
      body: { name: 'Ventas', phoneNumberId, wabaId, accessToken: TOKEN, appSecret },
    });
    if (res.status !== 201) throw new Error(`conectar → ${res.status}`);
    return res.body.id;
  };
  const sync = (s: Session, channelId: string) =>
    http<{ created: number; updated: number; templates: TemplateView[] }>(
      'POST',
      `/channels/${channelId}/templates/sync`,
      { token: s.accessToken },
    );
  const sendTemplate = (s: Session, conversation: string, body: Record<string, unknown>) =>
    http<{ id: string; type: string; body: string }>(
      'POST',
      `/conversations/${conversation}/messages`,
      { token: s.accessToken, body },
    );

  try {
    /* ---------------------------------------------------------------------- */
    section('1 · Sincronizar desde Meta');
    const a = await registerOwner('a');
    const b = await registerOwner('b');
    const channelA = await connect(a, PHONE_A, WABA_A, SECRET_A);
    const channelB = await connect(b, PHONE_B, WABA_B, SECRET_B);

    const first = await sync(a, channelA);
    check(
      'trae las 5 plantillas de la cuenta',
      first.status === 200 && first.body.created === 5 && first.body.templates.length === 5,
      `${first.status} · ${first.body.created} nuevas`,
    );
    const byName = (list: TemplateView[], name: string) => list.find((t) => t.name === name)!;
    const cita = byName(first.body.templates, 'recordatorio_cita');
    check(
      'de cada una se leen su idioma, categoría, cuerpo y número de variables',
      cita.language === 'es' &&
        cita.category === 'UTILITY' &&
        cita.body.includes('{{1}}') &&
        cita.variableCount === 2 &&
        cita.sendable,
      `${cita.variableCount} variables`,
    );

    const again = await sync(a, channelA);
    check(
      'volver a sincronizar actualiza, no duplica',
      again.body.created === 0 &&
        again.body.updated === 5 &&
        (await db.waTemplate.count({ where: { channelId: channelA } })) === 5,
    );

    section('2 · Cuáles se pueden enviar y por qué no');
    const pending = byName(again.body.templates, 'en_revision');
    const withImage = byName(again.body.templates, 'con_imagen');
    const rejected = byName(again.body.templates, 'rechazada');
    check(
      'una pendiente de aprobación no se puede enviar, y lo dice',
      !pending.sendable && /pending/.test(pending.blockedReason ?? ''),
      pending.blockedReason ?? '',
    );
    check(
      'una con cabecera de imagen tampoco, por ahora',
      !withImage.sendable && /cabecera/.test(withImage.blockedReason ?? ''),
      withImage.blockedReason ?? '',
    );
    check(
      'una rechazada guarda el motivo que dio Meta',
      !rejected.sendable && rejected.rejectedReason === 'INVALID_FORMAT',
      rejected.rejectedReason ?? '',
    );

    section('3 · Meta avisa de un cambio de estado');
    await postWebhook(
      channelA,
      templateStatusEvent(PHONE_A, { id: 'meta-tpl-3' }, 'APPROVED'),
      SECRET_A,
    );
    let approved = null;
    for (let i = 0; i < 40 && approved?.status !== 'APPROVED'; i++) {
      await sleep(200);
      approved = await db.waTemplate.findFirst({
        where: { channelId: channelA, name: 'en_revision' },
        select: { status: true },
      });
    }
    check(
      'una aprobación deja la plantilla lista',
      approved?.status === 'APPROVED',
      approved?.status,
    );

    await postWebhook(
      channelA,
      templateStatusEvent(
        PHONE_A,
        { name: 'bienvenida', language: 'es' },
        'REJECTED',
        'ABUSIVE_CONTENT',
      ),
      SECRET_A,
    );
    let downgraded = null;
    for (let i = 0; i < 40 && downgraded?.status !== 'REJECTED'; i++) {
      await sleep(200);
      downgraded = await db.waTemplate.findFirst({
        where: { channelId: channelA, name: 'bienvenida' },
        select: { status: true, rejectedReason: true },
      });
    }
    check(
      'un rechazo se aplica aunque el aviso venga sin id, y guarda el motivo',
      downgraded?.status === 'REJECTED' && downgraded.rejectedReason === 'ABUSIVE_CONTENT',
      `${downgraded?.status} · ${downgraded?.rejectedReason ?? ''}`,
    );

    section('4 · Enviar fuera de la ventana de 24 h');
    await postWebhook(channelA, inboundText(PHONE_A, 'Hola, ¿siguen abiertos?'), SECRET_A);
    let conversation = null;
    for (let i = 0; i < 60 && !conversation; i++) {
      await sleep(200);
      conversation = await db.conversation.findFirst({
        where: { tenantId: a.tenantId },
        select: { id: true },
      });
    }
    if (!conversation) throw new Error('el worker no creó la conversación');
    const conversationId = conversation.id;
    // Se cierra la ventana a propósito.
    await db.conversation.update({
      where: { id: conversationId },
      data: { windowExpiresAt: new Date(Date.now() - 60_000) },
    });

    const freeText = await sendTemplate(a, conversationId, { body: 'Hola otra vez' });
    check(
      'con la ventana cerrada, el texto libre sigue dando 409',
      freeText.status === 409 &&
        (freeText.body as unknown as { type: string }).type === INBOX_PROBLEMS.WINDOW_CLOSED,
      `${freeText.status}`,
    );

    const available = await http<TemplateView[]>(
      'GET',
      `/conversations/${conversationId}/templates`,
      { token: a.accessToken },
    );
    check(
      'la conversación ofrece sólo las enviables de SU canal',
      available.status === 200 &&
        available.body.every((t) => t.sendable) &&
        available.body.some((t) => t.name === 'recordatorio_cita') &&
        !available.body.some((t) => t.name === 'solo_de_b'),
      `${available.body.length} plantillas`,
    );

    const sent = await sendTemplate(a, conversationId, {
      templateId: cita.id,
      variables: ['Lucía', 'martes a las 10'],
    });
    check(
      'una plantilla aprobada SÍ se envía, con su texto ya rellenado',
      sent.status === 201 &&
        sent.body.type === 'TEMPLATE' &&
        sent.body.body === 'Hola Lucía, te recordamos tu cita del martes a las 10.',
      `${sent.status} · ${sent.body.body}`,
    );

    let delivered = null;
    for (let i = 0; i < 60 && delivered?.status !== 'SENT'; i++) {
      await sleep(200);
      delivered = await db.message.findUnique({
        where: { id: sent.body.id },
        select: { status: true, errorMessage: true, templateId: true, templateParams: true },
      });
    }
    const toMeta = outbound.at(-1) as
      | {
          type?: string;
          template?: {
            name?: string;
            language?: { code?: string };
            components?: Array<{ parameters?: Array<{ text?: string }> }>;
          };
        }
      | undefined;
    check(
      'el worker la envía y Meta recibe nombre, idioma y parámetros en orden',
      delivered?.status === 'SENT' &&
        toMeta?.type === 'template' &&
        toMeta.template?.name === 'recordatorio_cita' &&
        toMeta.template.language?.code === 'es' &&
        toMeta.template.components?.[0]?.parameters?.map((p) => p.text).join('|') ===
          'Lucía|martes a las 10',
      `${delivered?.status} · ${JSON.stringify(toMeta?.template ?? {})}`,
    );
    check(
      'el mensaje guarda qué plantilla y con qué valores se usó',
      delivered?.templateId === cita.id &&
        JSON.stringify(delivered.templateParams) ===
          JSON.stringify({ variables: ['Lucía', 'martes a las 10'] }),
    );

    section('5 · Validaciones al enviar');
    const missing = await sendTemplate(a, conversationId, {
      templateId: cita.id,
      variables: ['Sólo una'],
    });
    const extra = await sendTemplate(a, conversationId, {
      templateId: cita.id,
      variables: ['una', 'dos', 'tres'],
    });
    check(
      'ni de menos ni de más: las variables tienen que cuadrar',
      missing.status === 400 && extra.status === 400,
      `${missing.status} · ${extra.status}`,
    );
    const blank = await sendTemplate(a, conversationId, {
      templateId: cita.id,
      variables: ['Lucía', '   '],
    });
    check('una variable vacía se rechaza', blank.status === 400, `${blank.status}`);
    const notApproved = await sendTemplate(a, conversationId, {
      templateId: byName(again.body.templates, 'rechazada').id,
      variables: [],
    });
    check(
      'una rechazada por Meta no se envía → 409 con su motivo',
      notApproved.status === 409 &&
        (notApproved.body as unknown as { type: string }).type === TEMPLATE_PROBLEMS.NOT_SENDABLE,
      `${notApproved.status}`,
    );
    const imageHeader = await sendTemplate(a, conversationId, {
      templateId: withImage.id,
      variables: ['hoy'],
    });
    check(
      'una con cabecera de imagen tampoco, y explica por qué',
      imageHeader.status === 409 &&
        /cabecera/.test((imageHeader.body as unknown as { detail: string }).detail),
      `${imageHeader.status}`,
    );
    const withText = await sendTemplate(a, conversationId, {
      templateId: cita.id,
      variables: ['Lucía', 'hoy'],
      body: 'y además esto',
    });
    check(
      'no se puede colar texto libre junto a una plantilla',
      withText.status === 400,
      `${withText.status}`,
    );

    section('6 · Aislamiento entre empresas');
    const syncB = await sync(b, channelB);
    check('la empresa B sincroniza las suyas', syncB.body.created === 1);
    const fromB = await http('GET', `/channels/${channelA}/templates`, { token: b.accessToken });
    check('B no ve las plantillas del canal de A → 404', fromB.status === 404, `${fromB.status}`);
    const syncOther = await http('POST', `/channels/${channelA}/templates/sync`, {
      token: b.accessToken,
    });
    check(
      'ni puede sincronizar el canal de A → 404',
      syncOther.status === 404,
      `${syncOther.status}`,
    );
    const foreign = await sendTemplate(a, conversationId, {
      templateId: syncB.body.templates[0]!.id,
      variables: [],
    });
    check(
      'la plantilla de otra empresa no se puede enviar → 404',
      foreign.status === 404,
      `${foreign.status}`,
    );
    // Dos canales de la MISMA empresa: aquí la RLS no separa nada, y lo único
    // que impide pisar la plantilla equivocada es acotar por canal.
    const pro = await db.plan.findUniqueOrThrow({ where: { code: 'pro' } });
    await db.subscription.update({ where: { tenantId: a.tenantId }, data: { planId: pro.id } });
    catalogue.set(WABA_A2, [
      {
        id: 'meta-tpl-a2',
        name: 'recordatorio_cita',
        language: 'es',
        category: 'UTILITY',
        status: 'APPROVED',
        components: [bodyComponent('Hola {{1}}, cita del {{2}} (segundo número).')],
      },
    ]);
    const channelA2 = await connect(a, PHONE_A2, WABA_A2, SECRET_A);
    await sync(a, channelA2);
    await postWebhook(
      channelA2,
      templateStatusEvent(PHONE_A2, { name: 'recordatorio_cita', language: 'es' }, 'PAUSED'),
      SECRET_A,
    );
    await sleep(2000);
    const [first2, second] = await Promise.all([
      db.waTemplate.findFirst({
        where: { channelId: channelA, name: 'recordatorio_cita' },
        select: { status: true },
      }),
      db.waTemplate.findFirst({
        where: { channelId: channelA2, name: 'recordatorio_cita' },
        select: { status: true },
      }),
    ]);
    check(
      'dos canales de la misma empresa con la misma plantilla: el aviso sólo toca el suyo',
      first2?.status === 'APPROVED' && second?.status === 'PAUSED',
      `${first2?.status} · ${second?.status}`,
    );

    check(
      'el aviso de estado de un canal no toca las plantillas de otra empresa',
      (await postWebhook(
        channelB,
        templateStatusEvent(PHONE_B, { name: 'recordatorio_cita', language: 'es' }, 'REJECTED'),
        SECRET_B,
      )) === 200 &&
        (await (async () => {
          await sleep(1500);
          const row = await db.waTemplate.findFirst({
            where: { channelId: channelA, name: 'recordatorio_cita' },
            select: { status: true },
          });
          return row?.status === 'APPROVED';
        })()),
    );
  } finally {
    await db.tenant.deleteMany({ where: { id: { in: tenantIds } } }).catch(() => undefined);
    await db.$disconnect();
    await new Promise((r) => meta.close(r));
  }

  summarize('Plantillas de WhatsApp de extremo a extremo superadas.');
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
