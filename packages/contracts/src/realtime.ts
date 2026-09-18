import { z } from 'zod';

/**
 * Avisos en tiempo real (SSE).
 *
 * Un aviso NO lleva datos: sólo dice qué conversación cambió y a quién está
 * asignada. La web vuelve a pedir lo que muestra por la API normal, que aplica
 * permisos y alcance como en cualquier otra petición. Así el canal de avisos
 * no puede filtrar nada que la API no daría, y no hay dos fuentes de verdad.
 *
 * La API y el worker los publican en Redis (`realtimeChannel(empresa)`); cada
 * proceso de la API los reparte entre las conexiones abiertas de esa empresa
 * que pueden ver esa conversación.
 */

export const REALTIME_REASONS = [
  /** Mensaje nuevo, entrante o saliente. */
  'message',
  /** Cambió el estado de entrega de un mensaje. */
  'delivery',
  /** Se asignó, se tomó o se liberó. */
  'assignment',
  /** Se resolvió o se reabrió. */
  'status',
  /** Se leyó (contador de no leídos a cero). */
  'read',
] as const;
export type RealtimeReason = (typeof REALTIME_REASONS)[number];

export const realtimeEventSchema = z.object({
  type: z.literal('conversation'),
  conversationId: z.string().uuid(),
  /** Asignación DESPUÉS del cambio: decide quién recibe el aviso. */
  assigneeId: z.string().uuid().nullable(),
  /** Asignación anterior, si cambió: quien la pierde también debe enterarse. */
  previousAssigneeId: z.string().uuid().nullable().optional(),
  reason: z.enum(REALTIME_REASONS),
});
export type RealtimeEvent = z.infer<typeof realtimeEventSchema>;

export const REALTIME_PREFIX = 'nexo:rt:';
export const realtimeChannel = (tenantId: string): string => `${REALTIME_PREFIX}${tenantId}`;
