import { QUEUE_NAMES, type RealtimeEvent, whatsappOutboundJobSchema } from '@nexo/contracts';
import { decrypt, runInTenantTransaction } from '@nexo/database';
import { UnrecoverableError } from 'bullmq';
import { env } from '../bootstrap/env';
import { GraphSendError, INVALID_TOKEN_CODE, sendWhatsappText } from '../lib/graph';
import { defineProcessor } from '../lib/processor';
import { publishRealtime } from '../lib/realtime';

/**
 * Envía a Meta un mensaje que un agente escribió en la bandeja.
 *
 * La llamada a Meta va FUERA de cualquier transacción: esperar a un tercero
 * con una conexión de la base de datos abierta la agota en cuanto Meta va
 * lento. Se lee, se envía y se escribe el resultado, cada paso por separado.
 *
 * Idempotencia: sólo se envía un mensaje en estado QUEUED, y el resultado se
 * escribe con la condición «sigue en QUEUED». Queda una ventana inevitable
 * —Meta acepta y el worker cae antes de guardarlo— en la que el reintento lo
 * enviaría otra vez; Meta no ofrece clave de idempotencia para evitarlo.
 */
export const whatsappOutboundProcessor = defineProcessor({
  queue: QUEUE_NAMES.WHATSAPP_OUTBOUND,
  schema: whatsappOutboundJobSchema,
  tenantOf: (data) => data.tenantId,

  async handle(data, { job, log }) {
    const message = await runInTenantTransaction((tx) =>
      tx.message.findUnique({
        where: { id: data.messageId },
        select: {
          id: true,
          status: true,
          direction: true,
          body: true,
          conversationId: true,
          conversation: {
            select: { assigneeId: true, contact: { select: { whatsappE164: true } } },
          },
          channel: {
            select: { id: true, status: true, externalId: true, credentialsEncrypted: true },
          },
        },
      }),
    );
    if (!message) throw new UnrecoverableError(`No existe el mensaje ${data.messageId}`);
    if (message.direction !== 'OUTBOUND') {
      throw new UnrecoverableError('Sólo se envían mensajes salientes');
    }
    if (message.status !== 'QUEUED') return { skipped: `ya en estado ${message.status}` };

    const event: RealtimeEvent = {
      type: 'conversation',
      conversationId: message.conversationId,
      assigneeId: message.conversation.assigneeId,
      reason: 'delivery',
    };
    const fail = async (reason: string, code?: number) => {
      await markFailed(message.id, reason, code);
      await publishRealtime(data.tenantId, [event]);
      log.warn({ messageId: message.id, code, reason }, 'Mensaje de WhatsApp no enviado');
      return { failed: reason };
    };

    const { channel } = message;
    const to = message.conversation.contact.whatsappE164?.replace(/\D/g, '');
    if (channel.status !== 'CONNECTED' || !channel.externalId || !channel.credentialsEncrypted) {
      return fail('El canal está desconectado.');
    }
    if (!to) return fail('El contacto no tiene número de WhatsApp.');
    if (!message.body) return fail('El mensaje está vacío.');

    const { accessToken } = JSON.parse(
      decrypt(channel.credentialsEncrypted, env.ENCRYPTION_KEY),
    ) as { accessToken: string };

    let wamid: string;
    try {
      wamid = await sendWhatsappText(channel.externalId, accessToken, to, message.body);
    } catch (error) {
      if (!(error instanceof GraphSendError)) throw error;
      const lastAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
      if (error.retryable && !lastAttempt) throw error;

      if (error.code === INVALID_TOKEN_CODE) {
        // Todo envío de este canal va a fallar igual: que se vea en Ajustes.
        await runInTenantTransaction((tx) =>
          tx.channel.update({
            where: { id: channel.id },
            data: { lastErrorAt: new Date(), lastErrorMessage: error.message.slice(0, 1000) },
          }),
        );
      }
      return fail(error.message, error.code);
    }

    await runInTenantTransaction(async (tx) => {
      await tx.message.updateMany({
        where: { id: message.id, status: 'QUEUED' },
        data: { status: 'SENT', externalId: wamid, statusUpdatedAt: new Date() },
      });
    });
    await publishRealtime(data.tenantId, [event]);
    log.info({ messageId: message.id }, 'Mensaje de WhatsApp enviado');
    return { sent: wamid };
  },
});

async function markFailed(id: string, reason: string, code?: number): Promise<void> {
  await runInTenantTransaction((tx) =>
    tx.message.updateMany({
      where: { id, status: 'QUEUED' },
      data: {
        status: 'FAILED',
        statusUpdatedAt: new Date(),
        errorCode: code !== undefined ? String(code) : null,
        errorMessage: reason.slice(0, 1000),
      },
    }),
  );
}
