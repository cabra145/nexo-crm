import {
  type MetaChangeValue,
  type MetaInboundMessage,
  type MetaStatus,
  metaWebhookSchema,
  QUEUE_NAMES,
  waIdToE164,
  whatsappInboundJobSchema,
} from '@nexo/contracts';
import {
  type MessageDeliveryStatus,
  type MessageType,
  platformPrisma,
  runInTenantTransaction,
  type TenantTransactionClient,
} from '@nexo/database';
import { UnrecoverableError } from 'bullmq';
import { defineProcessor } from '../lib/processor';

/** Ventana de 24 h de Meta para responder con texto libre. */
const WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Orden de los estados de entrega. Meta NO garantiza el orden de los
 * webhooks: un «entregado» puede llegar después de «leído». Un estado sólo se
 * aplica si avanza; si no, se ignora. «Fallido» cuenta tras «enviado», pero no
 * deshace uno ya entregado o leído.
 */
const STATUS_RANK: Record<MessageDeliveryStatus, number> = {
  QUEUED: 0,
  SENT: 1,
  FAILED: 1.5,
  DELIVERED: 2,
  READ: 3,
};

const META_STATUS: Record<string, MessageDeliveryStatus> = {
  sent: 'SENT',
  delivered: 'DELIVERED',
  read: 'READ',
  failed: 'FAILED',
};

interface Summary {
  messages: number;
  duplicates: number;
  statuses: number;
  newContacts: number;
}

/**
 * Procesa un webhook de WhatsApp ya guardado: crea o reconoce al contacto por
 * su número, abre (o reabre) su conversación y guarda el mensaje; o aplica un
 * cambio de estado de entrega.
 *
 * Todo el evento va en UNA transacción de su empresa: o se aplica entero o
 * no se aplica, y el reintento de BullMQ lo vuelve a intentar desde cero. Los
 * mensajes son idempotentes por su id de Meta (`wamid`), así que reprocesar
 * un evento no duplica nada.
 */
export const whatsappInboundProcessor = defineProcessor({
  queue: QUEUE_NAMES.WHATSAPP_INBOUND,
  schema: whatsappInboundJobSchema,
  tenantOf: (data) => data.tenantId,

  async handle(data, { log }) {
    const event = await platformPrisma.webhookEvent.findUnique({
      where: { id: data.webhookEventId },
      select: { id: true, status: true, payload: true, channelId: true, tenantId: true },
    });
    if (!event) throw new UnrecoverableError(`No existe el evento ${data.webhookEventId}`);
    if (event.status === 'PROCESSED') return { skipped: 'ya procesado' };
    // El trabajo tiene que coincidir con lo que se guardó al recibirlo.
    if (event.channelId !== data.channelId || event.tenantId !== data.tenantId) {
      throw new UnrecoverableError('El trabajo no corresponde con el evento guardado');
    }

    const parsed = metaWebhookSchema.safeParse(event.payload);
    if (!parsed.success) {
      await finish(
        event.id,
        'IGNORED',
        `Carga no reconocida: ${parsed.error.issues[0]?.message ?? ''}`,
      );
      return { ignored: 'carga no reconocida' };
    }

    await platformPrisma.webhookEvent.update({
      where: { id: event.id },
      data: { status: 'PROCESSING', attempts: { increment: 1 } },
    });

    let summary: Summary;
    try {
      summary = await runInTenantTransaction(async (tx) => {
        const channel = await tx.channel.findUnique({
          where: { id: data.channelId },
          select: { id: true, externalId: true, status: true },
        });
        if (!channel || channel.status === 'DISABLED' || !channel.externalId) {
          throw new IgnoredEvent('El canal ya no está conectado');
        }

        const result: Summary = { messages: 0, duplicates: 0, statuses: 0, newContacts: 0 };
        for (const entry of parsed.data.entry) {
          for (const change of entry.changes) {
            if (change.field !== 'messages') continue;
            // Un evento de OTRO número que llega por la URL de este canal (una
            // app de Meta mal configurada, o alguien reenviando eventos) no
            // se procesa: el canal es el de la URL y su número es el que es.
            if (change.value.metadata?.phone_number_id !== channel.externalId) {
              throw new IgnoredEvent(
                `El evento es del número ${change.value.metadata?.phone_number_id ?? '?'}, no del de este canal`,
              );
            }
            await ingestChange(tx, data.tenantId, channel.id, change.value, result);
          }
        }
        return result;
      });
    } catch (error) {
      if (error instanceof IgnoredEvent) {
        await finish(event.id, 'IGNORED', error.message);
        log.warn(
          { webhookEventId: event.id, reason: error.message },
          'Evento de WhatsApp ignorado',
        );
        return { ignored: error.message };
      }
      await platformPrisma.webhookEvent.update({
        where: { id: event.id },
        data: { status: 'FAILED', lastError: (error as Error).message.slice(0, 1000) },
      });
      throw error;
    }

    await finish(event.id, 'PROCESSED', null);
    log.info({ webhookEventId: event.id, ...summary }, 'Evento de WhatsApp procesado');
    return summary;
  },
});

class IgnoredEvent extends Error {}

async function finish(
  id: string,
  status: 'PROCESSED' | 'IGNORED',
  lastError: string | null,
): Promise<void> {
  await platformPrisma.webhookEvent.update({
    where: { id },
    data: { status, lastError, processedAt: new Date() },
  });
}

async function ingestChange(
  tx: TenantTransactionClient,
  tenantId: string,
  channelId: string,
  value: MetaChangeValue,
  result: Summary,
): Promise<void> {
  const names = new Map(
    (value.contacts ?? []).map((c) => [c.wa_id, c.profile?.name?.trim() || null]),
  );
  for (const message of value.messages ?? []) {
    await ingestMessage(tx, tenantId, channelId, message, names.get(message.from) ?? null, result);
  }
  for (const status of value.statuses ?? []) {
    await applyStatus(tx, channelId, status, result);
  }
}

async function ingestMessage(
  tx: TenantTransactionClient,
  tenantId: string,
  channelId: string,
  message: MetaInboundMessage,
  profileName: string | null,
  result: Summary,
): Promise<void> {
  // Idempotencia: Meta reintenta, y un mismo `wamid` puede llegar en dos
  // eventos distintos. El índice único (canal, id externo) es la última red.
  const existing = await tx.message.findFirst({
    where: { channelId, externalId: message.id },
    select: { id: true },
  });
  if (existing) {
    result.duplicates += 1;
    return;
  }

  const phone = waIdToE164(message.from);
  const contact = await findOrCreateContact(tx, tenantId, phone, profileName, result);
  const sentAt = new Date(Number(message.timestamp) * 1000);
  const { type, body } = describe(message);

  const conversation = await tx.conversation.upsert({
    where: { channelId_contactId: { channelId, contactId: contact.id } },
    create: { tenantId, channelId, contactId: contact.id, status: 'OPEN' },
    update: {},
    select: { id: true, windowExpiresAt: true, createdAt: true, lastMessageAt: true },
  });

  await tx.message.create({
    data: {
      tenantId,
      conversationId: conversation.id,
      channelId,
      direction: 'INBOUND',
      type,
      body,
      externalId: message.id,
      status: 'DELIVERED',
      statusUpdatedAt: sentAt,
      senderType: 'USER',
      replyToExternalId: message.context?.id ?? null,
      rawPayload: message as object,
      createdAt: sentAt,
    },
  });

  // La ventana se mide desde el ÚLTIMO mensaje del contacto; un mensaje viejo
  // que llega tarde no la acorta.
  const windowEnd = new Date(sentAt.getTime() + WINDOW_MS);
  const isLatest = !conversation.lastMessageAt || sentAt >= conversation.lastMessageAt;
  await tx.conversation.update({
    where: { id: conversation.id },
    data: {
      unreadCount: { increment: 1 },
      // Un contacto que vuelve a escribir reabre la conversación.
      status: 'OPEN',
      resolvedAt: null,
      snoozedUntil: null,
      ...(!conversation.windowExpiresAt || windowEnd > conversation.windowExpiresAt
        ? { windowExpiresAt: windowEnd }
        : {}),
      ...(isLatest
        ? {
            lastMessageAt: sentAt,
            lastMessagePreview: preview(type, body),
            lastMessageDirection: 'INBOUND',
          }
        : {}),
    },
  });

  if (!conversation.lastMessageAt) {
    await tx.activity.create({
      data: {
        tenantId,
        type: 'WHATSAPP',
        subjectType: 'Conversation',
        subjectId: conversation.id,
        contactId: contact.id,
        actorType: 'SYSTEM',
        title: 'Escribió por WhatsApp por primera vez',
        summary: preview(type, body),
        occurredAt: sentAt,
      },
    });
  }
  result.messages += 1;
}

/**
 * El contacto se reconoce por su número, sea como WhatsApp o como teléfono.
 * Si no existe, se crea sin responsable: lo verá quien reparte el trabajo.
 *
 * Bloqueo por número dentro de la transacción: dos mensajes simultáneos de
 * alguien nuevo no crean dos contactos.
 */
async function findOrCreateContact(
  tx: TenantTransactionClient,
  tenantId: string,
  phone: string,
  profileName: string | null,
  result: Summary,
): Promise<{ id: string }> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`nexo:wa-contact:${tenantId}:${phone}`}, 0))`;

  const found = await tx.contact.findFirst({
    where: { deletedAt: null, OR: [{ whatsappE164: phone }, { phoneE164: phone }] },
    select: { id: true, whatsappE164: true },
    orderBy: { id: 'asc' },
  });
  if (found) {
    if (!found.whatsappE164) {
      await tx.contact.update({ where: { id: found.id }, data: { whatsappE164: phone } });
    }
    return found;
  }

  const [firstName, ...rest] = (profileName ?? phone).split(/\s+/);
  const created = await tx.contact.create({
    data: {
      tenantId,
      firstName: (firstName ?? phone).slice(0, 80),
      lastName: rest.length ? rest.join(' ').slice(0, 80) : null,
      phoneE164: phone,
      whatsappE164: phone,
      source: 'whatsapp',
      ownerId: null,
    },
    select: { id: true },
  });
  await tx.activity.create({
    data: {
      tenantId,
      type: 'SYSTEM',
      subjectType: 'Contact',
      subjectId: created.id,
      contactId: created.id,
      actorType: 'SYSTEM',
      title: 'Contacto creado desde WhatsApp',
    },
  });
  result.newContacts += 1;
  return created;
}

async function applyStatus(
  tx: TenantTransactionClient,
  channelId: string,
  status: MetaStatus,
  result: Summary,
): Promise<void> {
  const next = META_STATUS[status.status];
  if (!next) return;
  const message = await tx.message.findFirst({
    where: { channelId, externalId: status.id },
    select: { id: true, status: true },
  });
  // Estado de un mensaje que no es nuestro (enviado desde otra herramienta):
  // no hay nada que actualizar.
  if (!message) return;
  if (STATUS_RANK[next] <= STATUS_RANK[message.status]) return;

  const error = status.errors?.[0];
  await tx.message.update({
    where: { id: message.id },
    data: {
      status: next,
      statusUpdatedAt: new Date(Number(status.timestamp) * 1000),
      ...(next === 'FAILED'
        ? {
            errorCode: error ? String(error.code) : null,
            errorMessage: error?.title ?? null,
          }
        : {}),
    },
  });
  result.statuses += 1;
}

/** Tipo del mensaje en Nexo y el texto que lo representa. */
function describe(message: MetaInboundMessage): { type: MessageType; body: string | null } {
  switch (message.type) {
    case 'text':
      return { type: 'TEXT', body: message.text?.body ?? '' };
    case 'image':
      return { type: 'IMAGE', body: message.image?.caption ?? null };
    case 'video':
      return { type: 'VIDEO', body: message.video?.caption ?? null };
    case 'audio':
      return { type: 'AUDIO', body: null };
    case 'document':
      return {
        type: 'DOCUMENT',
        body: message.document?.caption ?? message.document?.filename ?? null,
      };
    case 'sticker':
      return { type: 'STICKER', body: null };
    case 'location': {
      const l = message.location;
      return {
        type: 'LOCATION',
        body: l
          ? [l.name, l.address].filter(Boolean).join(' · ') || `${l.latitude}, ${l.longitude}`
          : null,
      };
    }
    case 'button':
      return { type: 'INTERACTIVE', body: message.button?.text ?? null };
    case 'interactive': {
      const reply = (message.interactive ?? {}) as {
        button_reply?: { title?: string };
        list_reply?: { title?: string };
      };
      return {
        type: 'INTERACTIVE',
        body: reply.button_reply?.title ?? reply.list_reply?.title ?? null,
      };
    }
    case 'reaction':
      return { type: 'REACTION', body: message.reaction?.emoji ?? null };
    case 'contacts':
      return { type: 'CONTACTS', body: 'Compartió un contacto' };
    default:
      return { type: 'SYSTEM', body: `Mensaje de tipo «${message.type}» que Nexo aún no muestra` };
  }
}

const LABELS: Partial<Record<MessageType, string>> = {
  IMAGE: 'Imagen',
  VIDEO: 'Vídeo',
  AUDIO: 'Audio',
  DOCUMENT: 'Documento',
  STICKER: 'Sticker',
  LOCATION: 'Ubicación',
  CONTACTS: 'Contacto',
  REACTION: 'Reacción',
};

/** Vista previa para la lista de conversaciones. */
function preview(type: MessageType, body: string | null): string {
  const label = LABELS[type];
  const text = body?.trim() ?? '';
  const value = label ? (text ? `${label}: ${text}` : label) : text || 'Mensaje';
  return value.length > 200 ? `${value.slice(0, 197)}…` : value;
}
