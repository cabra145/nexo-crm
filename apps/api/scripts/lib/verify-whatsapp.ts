/**
 * Comprobaciones de un canal de WhatsApp contra la Graph API.
 *
 * Vive aparte del guion de línea de órdenes para que el CI pueda ejecutarlas
 * contra el simulador: así, cuando se lancen contra Meta de verdad, lo único
 * sin probar es la configuración, no la herramienta.
 *
 * Ninguna comprobación escribe nada en Meta, salvo `sendTestMessage`, que
 * sólo se usa si quien ejecuta lo pide expresamente.
 */

export interface VerifyCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface VerifyTarget {
  graphUrl: string;
  version: string;
  accessToken: string;
  phoneNumberId: string;
  wabaId: string | null;
  /** Lo que Nexo tiene guardado, para contrastarlo con lo que dice Meta. */
  displayId: string | null;
  /** URL del webhook que Meta debe tener dada de alta. */
  webhookUrl: string;
  verifyToken: string;
}

const base = (target: VerifyTarget) => `${target.graphUrl.replace(/\/$/, '')}/${target.version}`;

/** Nunca devuelve el token, ni siquiera en los mensajes de error. */
async function graph(
  target: VerifyTarget,
  path: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${base(target)}/${path}`, {
    headers: { Authorization: `Bearer ${target.accessToken}` },
    signal: AbortSignal.timeout(20_000),
  });
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: response.status, body };
}

const errorOf = (body: Record<string, unknown>): string => {
  const error = body.error as { message?: string; code?: number } | undefined;
  return error?.message ?? 'sin detalle';
};

/** Todas las comprobaciones de lectura. No escriben nada en Meta. */
export async function verifyWhatsappChannel(target: VerifyTarget): Promise<VerifyCheck[]> {
  const checks: VerifyCheck[] = [];
  const add = (name: string, ok: boolean, detail = '') => checks.push({ name, ok, detail });

  // 1 · Versión de la Graph API y acceso al número.
  const phone = await graph(
    target,
    `${target.phoneNumberId}?fields=id,display_phone_number,verified_name`,
  );
  const phoneOk = phone.status === 200;
  add(
    `la versión ${target.version} de la Graph API responde y el token da acceso al número`,
    phoneOk,
    phoneOk ? '' : `${phone.status} · ${errorOf(phone.body)}`,
  );
  if (phoneOk) {
    const display =
      typeof phone.body.display_phone_number === 'string' ? phone.body.display_phone_number : '';
    const verifiedName =
      typeof phone.body.verified_name === 'string' ? phone.body.verified_name : '';
    const normalized = `+${display.replace(/\D/g, '')}`;
    add(
      'el número que devuelve Meta es el que Nexo tiene guardado',
      target.displayId === null || normalized === target.displayId,
      `Meta: ${display || '—'} · Nexo: ${target.displayId ?? '—'}`,
    );
    add('el número tiene nombre verificado', verifiedName !== '', verifiedName || '—');
  }

  // 2 · Cuenta de WhatsApp Business: hace falta para las plantillas.
  if (!target.wabaId) {
    add('el canal guarda su cuenta de WhatsApp Business', false, 'vuelve a conectar el número');
  } else {
    const templates = await graph(target, `${target.wabaId}/message_templates?limit=1`);
    add(
      'el token también da acceso a la cuenta de WhatsApp Business (plantillas)',
      templates.status === 200,
      templates.status === 200 ? '' : `${templates.status} · ${errorOf(templates.body)}`,
    );

    const subscribed = await graph(target, `${target.wabaId}/subscribed_apps`);
    const apps = Array.isArray(subscribed.body.data) ? subscribed.body.data : [];
    add(
      'la app de Meta está suscrita a la cuenta (sin esto no llegan webhooks)',
      subscribed.status === 200 && apps.length > 0,
      subscribed.status === 200
        ? `${apps.length} app(s) suscritas`
        : `${subscribed.status} · ${errorOf(subscribed.body)}`,
    );
  }

  // 3 · El webhook, desde fuera.
  const webhook = new URL(target.webhookUrl);
  add(
    'la URL del webhook es pública y con https',
    webhook.protocol === 'https:' && !['localhost', '127.0.0.1'].includes(webhook.hostname),
    `${webhook.protocol}//${webhook.host}`,
  );
  const challenge = `nexo-${Date.now()}`;
  const verification = new URL(target.webhookUrl);
  verification.searchParams.set('hub.mode', 'subscribe');
  verification.searchParams.set('hub.verify_token', target.verifyToken);
  verification.searchParams.set('hub.challenge', challenge);
  try {
    const response = await fetch(verification, { signal: AbortSignal.timeout(15_000) });
    const text = await response.text();
    add(
      'la URL del webhook contesta la verificación de Meta',
      response.status === 200 && text.trim() === challenge,
      `${response.status}${response.status === 200 ? '' : ` · ${text.slice(0, 120)}`}`,
    );
  } catch (error) {
    add(
      'la URL del webhook contesta la verificación de Meta',
      false,
      `no se pudo alcanzar: ${(error as Error).message}`,
    );
  }

  return checks;
}

/**
 * Envío de prueba REAL: cuesta dinero y abre conversación. Sólo se llama
 * cuando quien ejecuta lo pide con el número a mano.
 */
export async function sendTestMessage(
  target: VerifyTarget,
  to: string,
  body: string,
): Promise<VerifyCheck> {
  const response = await fetch(`${base(target)}/${target.phoneNumberId}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${target.accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: to.replace(/\D/g, ''),
      type: 'text',
      text: { preview_url: false, body },
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const payload = (await response.json().catch(() => ({}))) as {
    messages?: Array<{ id?: string }>;
    error?: { message?: string; code?: number };
  };
  const wamid = payload.messages?.[0]?.id;
  if (response.ok && wamid) {
    return { name: 'envío de prueba aceptado por Meta', ok: true, detail: wamid };
  }
  const code = payload.error?.code;
  const hint =
    code === 131047 || code === 131051
      ? ' — ese número tiene que escribirte primero, o hay que enviarle una plantilla'
      : '';
  return {
    name: 'envío de prueba aceptado por Meta',
    ok: false,
    detail: `${response.status} · ${payload.error?.message ?? 'sin detalle'}${hint}`,
  };
}
