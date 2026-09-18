import { env } from '../bootstrap/env';

/**
 * Error de la Graph API de Meta, con lo necesario para decidir si reintentar.
 *
 * `retryable`: la red, un 5xx o un límite de tasa pasan solos; un token
 * inválido, un número que no existe o la ventana de 24 h cerrada, no, y
 * reintentarlos sólo retrasaría el aviso al agente.
 */
export class GraphSendError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly code?: number,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'GraphSendError';
  }
}

/**
 * Códigos de Meta que son límites de tasa: se reintentan.
 * 4 y 80007: límite de la app o de la cuenta; 130429: rendimiento del número;
 * 131048: límite por spam; 131056: demasiados mensajes al mismo destinatario.
 */
const RATE_LIMIT_CODES = new Set([4, 80007, 130429, 131048, 131056]);

/** Token inválido o caducado: el canal necesita que alguien lo reconecte. */
export const INVALID_TOKEN_CODE = 190;

/**
 * Envía un texto por WhatsApp Cloud API y devuelve el id del mensaje (wamid).
 *
 * `to` son los dígitos del número, sin «+» (así lo espera Meta).
 */
export async function sendWhatsappText(
  phoneNumberId: string,
  accessToken: string,
  to: string,
  body: string,
): Promise<string> {
  const url = `${env.META_GRAPH_URL.replace(/\/$/, '')}/${env.META_GRAPH_VERSION}/${phoneNumberId}/messages`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to,
        type: 'text',
        text: { preview_url: false, body },
      }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (cause) {
    throw new GraphSendError(`No se pudo contactar con Meta: ${(cause as Error).message}`, true);
  }

  const payload = (await response.json().catch(() => ({}))) as {
    messages?: Array<{ id?: string }>;
    error?: { message?: string; code?: number; error_data?: { details?: string } };
  };

  if (!response.ok) {
    const code = payload.error?.code;
    const detail = payload.error?.error_data?.details;
    const message = [payload.error?.message ?? `Meta respondió ${response.status}`, detail]
      .filter(Boolean)
      .join(' — ');
    const retryable =
      response.status >= 500 ||
      response.status === 429 ||
      (code !== undefined && RATE_LIMIT_CODES.has(code));
    throw new GraphSendError(message, retryable, code, response.status);
  }

  const wamid = payload.messages?.[0]?.id;
  if (!wamid) throw new GraphSendError('Meta aceptó el mensaje pero no devolvió su id', false);
  return wamid;
}
