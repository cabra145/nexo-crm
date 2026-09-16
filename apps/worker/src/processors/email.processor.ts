import { emailJobSchema, QUEUE_NAMES } from '@nexo/contracts';
import nodemailer, { type Transporter } from 'nodemailer';
import { env } from '../bootstrap/env';
import { maskEmail } from '../lib/logger';
import { defineProcessor } from '../lib/processor';

/**
 * Se crea al primer envío y se reutiliza. `pool` mantiene abiertas unas pocas
 * conexiones SMTP en vez de abrir una por correo.
 */
let transporter: Transporter | null = null;

function getTransporter(): Transporter {
  if (transporter) return transporter;

  if (!env.SMTP_HOST || !env.SMTP_PORT || !env.SMTP_FROM) {
    // Error normal (no Unrecoverable): se reintenta. Si alguien completa la
    // configuración y reinicia el worker, los correos pendientes salen solos.
    throw new Error(
      'El correo no está configurado: faltan SMTP_HOST, SMTP_PORT o SMTP_FROM en el entorno.',
    );
  }

  transporter = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    // 465 es TLS implícito; 587 y 25 negocian STARTTLS por su cuenta.
    secure: env.SMTP_PORT === 465,
    auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASSWORD ?? '' } : undefined,
    pool: true,
    maxConnections: 3,
  });

  return transporter;
}

export const emailProcessor = defineProcessor({
  queue: QUEUE_NAMES.EMAIL,
  schema: emailJobSchema,
  tenantOf: (data) => data.tenantId,

  async handle(data, { log }) {
    const recipients = Array.isArray(data.to) ? data.to : [data.to];

    const info = await getTransporter().sendMail({
      from: env.SMTP_FROM,
      to: recipients,
      replyTo: data.replyTo,
      subject: data.subject,
      text: data.text,
      html: data.html,
      headers: {
        // Permite rastrear en el servidor de correo el mismo id que en los logs.
        ...(data.traceId ? { 'X-Nexo-Trace-Id': data.traceId } : {}),
        'X-Nexo-Category': data.category,
      },
    });

    log.info(
      {
        category: data.category,
        to: recipients.map(maskEmail),
        messageId: info.messageId,
      },
      'Correo enviado',
    );

    return { messageId: info.messageId, accepted: info.accepted.length };
  },
});

/** Cierre ordenado: termina de vaciar el pool de conexiones SMTP. */
export function closeEmailTransport(): void {
  transporter?.close();
  transporter = null;
}
