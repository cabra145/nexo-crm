import { z } from 'zod';

/**
 * Contrato de WhatsApp Business Cloud API: conexión del canal y la forma de
 * los webhooks de Meta.
 *
 * El esquema del webhook es PERMISIVO a propósito: Meta añade campos sin
 * avisar, y rechazar un evento por un campo nuevo sería perder mensajes. Sólo
 * se exige lo que el procesamiento necesita de verdad.
 */

/* ========================================================================== */
/*  Conexión del canal                                                          */
/* ========================================================================== */

const digits = (label: string) =>
  z
    .string()
    .trim()
    .regex(/^\d{5,30}$/, `${label}: sólo dígitos, como aparece en Meta`);

export const connectWhatsappSchema = z.object({
  name: z.string().trim().min(2, 'ponle un nombre al canal').max(80),
  /** «Identificador del número de teléfono» en el panel de Meta. */
  phoneNumberId: digits('identificador del número'),
  /** «Identificador de la cuenta de WhatsApp Business». */
  wabaId: digits('identificador de la cuenta'),
  /** Token de acceso de un usuario del sistema, con permiso whatsapp_business_messaging. */
  accessToken: z.string().trim().min(20, 'el token parece incompleto').max(1000),
  /** Clave secreta de la app de Meta: firma los webhooks. */
  appSecret: z
    .string()
    .trim()
    .regex(/^[0-9a-f]{32}$/i, 'la clave secreta de la app son 32 caracteres hexadecimales'),
});
export type ConnectWhatsappInput = z.infer<typeof connectWhatsappSchema>;

export const CHANNEL_STATUSES = ['PENDING', 'CONNECTED', 'ERROR', 'DISABLED'] as const;
export type ChannelStatus = (typeof CHANNEL_STATUSES)[number];

export interface ChannelView {
  id: string;
  type: 'WHATSAPP_CLOUD';
  name: string;
  status: ChannelStatus;
  /** Número en E.164, para mostrar. */
  displayId: string | null;
  /** Nombre verificado del negocio en Meta. */
  verifiedName: string | null;
  phoneNumberId: string | null;
  /** URL que hay que pegar en la configuración del webhook de la app de Meta. */
  webhookUrl: string;
  /** Token de verificación que Meta pide junto a la URL. */
  verifyToken: string;
  connectedAt: string | null;
  lastErrorAt: string | null;
  lastErrorMessage: string | null;
}

/* ========================================================================== */
/*  Webhook de Meta                                                             */
/* ========================================================================== */

const metaMedia = z
  .object({ id: z.string(), mime_type: z.string().optional(), caption: z.string().optional() })
  .passthrough();

export const metaInboundMessageSchema = z
  .object({
    from: z.string(),
    id: z.string(),
    timestamp: z.string(),
    type: z.string(),
    text: z.object({ body: z.string() }).passthrough().optional(),
    image: metaMedia.optional(),
    video: metaMedia.optional(),
    audio: metaMedia.optional(),
    document: metaMedia.extend({ filename: z.string().optional() }).optional(),
    sticker: metaMedia.optional(),
    location: z
      .object({
        latitude: z.number(),
        longitude: z.number(),
        name: z.string().optional(),
        address: z.string().optional(),
      })
      .passthrough()
      .optional(),
    button: z.object({ text: z.string() }).passthrough().optional(),
    interactive: z.record(z.unknown()).optional(),
    reaction: z.object({ emoji: z.string().optional() }).passthrough().optional(),
    context: z.object({ id: z.string().optional() }).passthrough().optional(),
  })
  .passthrough();
export type MetaInboundMessage = z.infer<typeof metaInboundMessageSchema>;

export const metaStatusSchema = z
  .object({
    id: z.string(),
    status: z.string(),
    timestamp: z.string(),
    recipient_id: z.string().optional(),
    errors: z
      .array(z.object({ code: z.number(), title: z.string().optional() }).passthrough())
      .optional(),
  })
  .passthrough();
export type MetaStatus = z.infer<typeof metaStatusSchema>;

/** Lo que el procesamiento usa de un cambio del webhook. */
export interface MetaChangeValue {
  messaging_product?: string;
  metadata?: { phone_number_id: string; display_phone_number?: string };
  contacts?: Array<{ wa_id: string; profile?: { name?: string } }>;
  messages?: MetaInboundMessage[];
  statuses?: MetaStatus[];
}

export interface MetaWebhook {
  object: string;
  entry: Array<{ id: string; changes: Array<{ field: string; value: MetaChangeValue }> }>;
}

/*
 * Tipo explícito: el que inferiría zod con tantos `passthrough` es demasiado
 * grande para que TypeScript lo emita en las declaraciones.
 */
export const metaWebhookSchema: z.ZodType<MetaWebhook, z.ZodTypeDef, unknown> = z.object({
  object: z.string(),
  entry: z.array(
    z.object({
      id: z.string(),
      changes: z.array(
        z.object({
          field: z.string(),
          value: z.object({
            messaging_product: z.string().optional(),
            metadata: z
              .object({
                phone_number_id: z.string(),
                display_phone_number: z.string().optional(),
              })
              .optional(),
            contacts: z
              .array(
                z.object({
                  wa_id: z.string(),
                  profile: z.object({ name: z.string().optional() }).optional(),
                }),
              )
              .optional(),
            messages: z.array(metaInboundMessageSchema).optional(),
            statuses: z.array(metaStatusSchema).optional(),
          }),
        }),
      ),
    }),
  ),
});

/** El `wa_id` de Meta son dígitos sin «+»; en el CRM todo teléfono va en E.164. */
export const waIdToE164 = (waId: string): string => `+${waId.replace(/\D/g, '')}`;

export const WHATSAPP_PROBLEMS = {
  /** Meta rechazó el token o el identificador al conectar. */
  META_REJECTED: 'https://nexo.app/problems/meta-rechazo-la-conexion',
  /** El número ya está conectado en otra empresa de Nexo. */
  NUMBER_IN_USE: 'https://nexo.app/problems/numero-ya-conectado',
  CHANNEL_QUOTA: 'https://nexo.app/problems/limite-de-canales',
} as const;
