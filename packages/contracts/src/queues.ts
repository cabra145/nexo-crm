import { z } from 'zod';
import { emailSchema, uuidSchema } from './common';

/**
 * Contrato de las colas de trabajo entre la API (que encola) y el worker (que
 * procesa).
 *
 * La carga útil de cada trabajo se valida con zod AL PROCESARLA, no sólo al
 * encolarla: lo que hay en Redis puede venir de una versión anterior de la API,
 * de un reintento de hace horas o de alguien con acceso a Redis. Un trabajo
 * con datos inválidos se descarta sin reintentos, con el motivo en el log.
 *
 * Sólo existen aquí las colas que tienen un procesador real. Las del plan de
 * arquitectura (WhatsApp, IA, automatizaciones, PDF…) se añaden con su fase.
 */

export const QUEUE_NAMES = {
  /** Correo transaccional: verificación, recuperación, invitaciones, avisos. */
  EMAIL: 'email',
  /**
   * Registro de auditoría. Va por cola para que escribirlo no añada latencia a
   * la petición del usuario, que es lo que se audita.
   */
  AUDIT: 'audit',
  /**
   * Webhooks de WhatsApp ya recibidos y guardados. La API responde a Meta en
   * cuanto el evento está a salvo en `webhook_event`; crear el contacto, la
   * conversación y el mensaje se hace aquí, con reintentos.
   */
  WHATSAPP_INBOUND: 'whatsapp-inbound',
  /**
   * Mensajes que un agente escribió en la bandeja. La API los guarda en cola
   * (QUEUED) y responde al momento; el envío a Meta se hace aquí, con
   * reintentos si Meta o la red fallan.
   */
  WHATSAPP_OUTBOUND: 'whatsapp-outbound',
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

/**
 * Política de reintentos y retención por cola.
 *
 * Datos planos, sin depender de BullMQ: la API y el worker los traducen a sus
 * opciones, y así este paquete lo puede importar también la web sin arrastrar
 * dependencias de servidor.
 */
export const QUEUE_POLICIES: Record<
  QueueName,
  {
    /** Intentos totales, incluido el primero. */
    attempts: number;
    /** Espera base del retroceso exponencial: base, base×2, base×4… */
    backoffMs: number;
    /** Trabajos completados que se conservan para inspección. */
    keepCompleted: { hours: number; max: number };
    /** Trabajos fallidos: más tiempo, porque son los que hay que investigar. */
    keepFailed: { days: number };
    concurrency: number;
  }
> = {
  email: {
    // Un servidor SMTP caído suele volver en minutos. 6 intentos con base de
    // 30 s cubren ~30 minutos antes de rendirse.
    attempts: 6,
    backoffMs: 30_000,
    keepCompleted: { hours: 24, max: 1_000 },
    keepFailed: { days: 14 },
    concurrency: 5,
  },
  'whatsapp-inbound': {
    // Si falla es por la base de datos: se insiste. Un mensaje de un cliente
    // que no llega a la bandeja es una venta que se pierde.
    attempts: 8,
    backoffMs: 5_000,
    keepCompleted: { hours: 6, max: 2_000 },
    keepFailed: { days: 30 },
    concurrency: 5,
  },
  'whatsapp-outbound': {
    // Reintentos cortos: quien escribe está mirando la pantalla. Cinco
    // intentos desde 2 s cubren ~1 minuto de Meta caído antes de marcarlo
    // fallido, y el agente puede reintentarlo a mano.
    attempts: 5,
    backoffMs: 2_000,
    keepCompleted: { hours: 6, max: 2_000 },
    keepFailed: { days: 30 },
    concurrency: 10,
  },
  audit: {
    // Sólo falla si la base de datos no responde. Se insiste bastante: perder
    // una entrada de auditoría es perder trazabilidad.
    attempts: 10,
    backoffMs: 5_000,
    keepCompleted: { hours: 1, max: 500 },
    keepFailed: { days: 30 },
    concurrency: 10,
  },
};

/* ========================================================================== */
/*  Cola `email`                                                              */
/* ========================================================================== */

export const EMAIL_CATEGORIES = [
  'auth',
  'invitation',
  'notification',
  'document',
  'system',
] as const;

export const emailJobSchema = z.object({
  to: z.union([emailSchema, z.array(emailSchema).min(1).max(50)]),
  subject: z.string().trim().min(1).max(200),
  /** Siempre hay versión de texto: hay clientes que no muestran HTML. */
  text: z.string().min(1),
  html: z.string().optional(),
  replyTo: emailSchema.optional(),
  /** Para métricas y para poder silenciar categorías por usuario más adelante. */
  category: z.enum(EMAIL_CATEGORIES),
  /** Empresa a la que pertenece el envío, si la hay. Los de registro no tienen. */
  tenantId: uuidSchema.optional(),
  traceId: z.string().max(64).optional(),
});

export type EmailJob = z.infer<typeof emailJobSchema>;

/* ========================================================================== */
/*  Cola `audit`                                                              */
/* ========================================================================== */

/**
 * Espejo de los enums `AuditAction` y `ActorType` de Prisma.
 *
 * No se importan de @nexo/database porque este paquete no puede depender de
 * él. Para que no diverjan, el worker compara ambos en COMPILACIÓN: si alguien
 * añade una acción al esquema y no aquí, el worker no compila.
 */
export const AUDIT_ACTIONS = [
  'CREATE',
  'UPDATE',
  'DELETE',
  'RESTORE',
  'LOGIN',
  'LOGIN_FAILED',
  'LOGOUT',
  'PASSWORD_CHANGE',
  'TWO_FACTOR_ENABLE',
  'TWO_FACTOR_DISABLE',
  'EXPORT',
  'IMPORT',
  'INVITE',
  'ROLE_CHANGE',
  'IMPERSONATE_START',
  'IMPERSONATE_END',
  'SETTINGS_CHANGE',
  'SEND',
] as const;

export const ACTOR_TYPES = ['USER', 'API_KEY', 'SYSTEM', 'AUTOMATION', 'SUPPORT'] as const;

export const auditJobSchema = z.object({
  /**
   * Id de la entrada, generado por quien encola.
   *
   * Hace idempotente el procesamiento: si el worker cae después de escribir y
   * antes de confirmar el trabajo, BullMQ lo reintenta, el segundo INSERT choca
   * con la clave primaria y se da por hecho. Sin esto, cada reintento duplicaría
   * la entrada de auditoría.
   */
  id: uuidSchema,
  tenantId: uuidSchema,
  actorUserId: uuidSchema.optional(),
  actorEmail: z.string().max(255).optional(),
  actorType: z.enum(ACTOR_TYPES).default('USER'),
  action: z.enum(AUDIT_ACTIONS),
  resourceType: z.string().min(1).max(60),
  resourceId: uuidSchema.optional(),
  resourceLabel: z.string().max(200).optional(),
  /** { campo: { antes, despues } }. Los campos sensibles llegan ya redactados. */
  changes: z.record(z.unknown()).optional(),
  ip: z.string().ip().optional(),
  userAgent: z.string().max(500).optional(),
  /** Igual que audit_log.trace_id, VARCHAR(40). Un UUID ocupa 36. */
  traceId: z.string().max(40).optional(),
  /** Cuándo ocurrió de verdad, no cuándo lo procesó el worker. */
  occurredAt: z.coerce.date(),
});

export type AuditJob = z.infer<typeof auditJobSchema>;

/* ========================================================================== */
/*  Cola `whatsapp-inbound`                                                   */
/* ========================================================================== */

export const whatsappInboundJobSchema = z.object({
  /** Fila de `webhook_event` con la carga tal cual llegó de Meta. */
  webhookEventId: uuidSchema,
  tenantId: uuidSchema,
  channelId: uuidSchema,
});
export type WhatsappInboundJob = z.infer<typeof whatsappInboundJobSchema>;

/* ========================================================================== */
/*  Cola `whatsapp-outbound`                                                  */
/* ========================================================================== */

export const whatsappOutboundJobSchema = z.object({
  /** Mensaje ya guardado en estado QUEUED. */
  messageId: uuidSchema,
  tenantId: uuidSchema,
});
export type WhatsappOutboundJob = z.infer<typeof whatsappOutboundJobSchema>;
