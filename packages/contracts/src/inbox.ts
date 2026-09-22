import { z } from 'zod';

/**
 * Bandeja de entrada: conversaciones de WhatsApp y sus mensajes.
 *
 * Reparto del trabajo: una conversación nueva llega SIN asignar y la ve todo
 * el que puede ver conversaciones, para que cualquiera la pueda tomar. Una vez
 * asignada, la ven quien la tiene y quien tenga alcance sobre esa persona
 * (su equipo, o toda la empresa).
 */

export const INBOX_VIEWS = ['mine', 'unassigned', 'all'] as const;
export type InboxView = (typeof INBOX_VIEWS)[number];

export const CONVERSATION_STATUSES = ['OPEN', 'PENDING', 'RESOLVED', 'SNOOZED'] as const;
export type ConversationStatus = (typeof CONVERSATION_STATUSES)[number];

export const conversationListQuerySchema = z.object({
  view: z.enum(INBOX_VIEWS).default('all'),
  /** Abiertas (por defecto) o resueltas. */
  state: z.enum(['open', 'resolved']).default('open'),
  q: z.string().trim().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
  /** Id de la última conversación de la página anterior. */
  cursor: z.string().uuid().optional(),
});
export type ConversationListQuery = z.infer<typeof conversationListQuerySchema>;

export interface ConversationSummary {
  id: string;
  status: ConversationStatus;
  contact: { id: string; name: string; phone: string | null };
  channel: { id: string; name: string; displayId: string | null };
  assignee: { id: string; name: string } | null;
  lastMessageAt: string | null;
  lastMessagePreview: string | null;
  lastMessageDirection: 'INBOUND' | 'OUTBOUND' | null;
  unreadCount: number;
  /** Fin de la ventana de 24 h de Meta; null si el contacto nunca escribió. */
  windowExpiresAt: string | null;
}

export interface ConversationCounts {
  mine: number;
  unassigned: number;
  all: number;
}

export interface ConversationList {
  data: ConversationSummary[];
  nextCursor: string | null;
  hasMore: boolean;
  /** No leídas por vista, para los contadores de las pestañas. */
  unread: ConversationCounts;
}

export interface ConversationDetail extends ConversationSummary {
  /** Lo que el usuario puede hacer con ESTA conversación, ya calculado. */
  can: {
    reply: boolean;
    /** Tomarla para sí (sólo si está sin asignar). */
    take: boolean;
    /** Asignarla a otra persona o liberarla. */
    assign: boolean;
  };
  channelConnected: boolean;
}

export const MESSAGE_TYPES = [
  'TEXT',
  'IMAGE',
  'AUDIO',
  'VIDEO',
  'DOCUMENT',
  'STICKER',
  'LOCATION',
  'CONTACTS',
  'TEMPLATE',
  'INTERACTIVE',
  'REACTION',
  'SYSTEM',
] as const;
export type MessageTypeName = (typeof MESSAGE_TYPES)[number];

export const DELIVERY_STATUSES = ['QUEUED', 'SENT', 'DELIVERED', 'READ', 'FAILED'] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

/**
 * El archivo de un mensaje, tal como lo ve la bandeja. NUNCA lleva la clave
 * del almacenamiento ni una URL: la URL se pide aparte, firmada y de vida
 * corta, sólo cuando se va a ver o descargar.
 */
export interface MessageMediaView {
  id: string;
  /** `ready`: descargado y comprobado. `pending`: en camino. `failed`: rechazado. */
  status: 'ready' | 'pending' | 'failed';
  /** Tipo REAL, el detectado al guardarlo; null mientras está pendiente. */
  mimeType: string | null;
  /** Nombre para mostrar y para la descarga. */
  filename: string | null;
  sizeBytes: number | null;
  /** Motivo, si no se pudo guardar. */
  error: string | null;
}

export interface MessageView {
  id: string;
  direction: 'INBOUND' | 'OUTBOUND';
  type: MessageTypeName;
  body: string | null;
  status: DeliveryStatus;
  errorMessage: string | null;
  sender: { id: string; name: string } | null;
  media: MessageMediaView | null;
  createdAt: string;
}

/** URL firmada para ver o descargar un archivo. */
export interface MediaUrlView {
  url: string;
  /** Instante exacto en que deja de servir; la web la vuelve a pedir. */
  expiresAt: string;
  filename: string;
  mimeType: string;
  /** Lo decide el servidor y va DENTRO de la firma. */
  disposition: 'inline' | 'attachment';
}

export const messageListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  /** Id del mensaje más ANTIGUO que ya se tiene: devuelve los anteriores. */
  before: z.string().uuid().optional(),
});
export type MessageListQuery = z.infer<typeof messageListQuerySchema>;

export interface MessagePage {
  /** En orden cronológico, del más antiguo al más reciente. */
  data: MessageView[];
  hasMore: boolean;
}

/** Límite de Meta para el cuerpo de un mensaje de texto. */
export const WHATSAPP_TEXT_MAX = 4096;

export const sendMessageSchema = z.object({
  body: z
    .string()
    .trim()
    .min(1, 'escribe un mensaje')
    .max(WHATSAPP_TEXT_MAX, `máximo ${WHATSAPP_TEXT_MAX} caracteres`),
});
export type SendMessageInput = z.infer<typeof sendMessageSchema>;

export const assignConversationSchema = z.object({
  /** null = liberarla (sin asignar). */
  userId: z.string().uuid().nullable(),
});
export type AssignConversationInput = z.infer<typeof assignConversationSchema>;

export const conversationStatusSchema = z.object({
  status: z.enum(['OPEN', 'RESOLVED']),
});
export type ConversationStatusInput = z.infer<typeof conversationStatusSchema>;

export const INBOX_PROBLEMS = {
  /** Pasaron 24 h desde el último mensaje del contacto: sólo plantillas. */
  WINDOW_CLOSED: 'https://nexo.app/problems/ventana-de-24h-cerrada',
  /** El canal se desconectó: no se puede enviar. */
  CHANNEL_DISCONNECTED: 'https://nexo.app/problems/canal-desconectado',
  /** Otra persona la tomó antes. */
  ALREADY_ASSIGNED: 'https://nexo.app/problems/conversacion-ya-asignada',
  /** El archivo aún no está descargado, o se rechazó al comprobarlo. */
  MEDIA_NOT_READY: 'https://nexo.app/problems/archivo-no-disponible',
} as const;
