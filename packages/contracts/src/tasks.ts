import { z } from 'zod';
import { cursorPaginationSchema, uuidSchema } from './common';

/**
 * Contrato de la agenda: tareas y notas, y la historia de un contacto.
 *
 * Las tareas tienen responsable (`assigneeId`), así que el alcance del rol se
 * aplica sobre ese campo igual que con los contactos: un agente ve las suyas,
 * un responsable las de su equipo.
 */

/* ========================================================================== */
/*  Tareas                                                                     */
/* ========================================================================== */

export const TASK_STATUSES = ['PENDING', 'IN_PROGRESS', 'DONE', 'CANCELLED'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  PENDING: 'Pendiente',
  IN_PROGRESS: 'En curso',
  DONE: 'Hecha',
  CANCELLED: 'Cancelada',
};

export const TASK_PRIORITIES = ['LOW', 'MEDIUM', 'HIGH', 'URGENT'] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

export const TASK_PRIORITY_LABELS: Record<TaskPriority, string> = {
  LOW: 'Baja',
  MEDIUM: 'Normal',
  HIGH: 'Alta',
  URGENT: 'Urgente',
};

export const taskCreateSchema = z.object({
  title: z.string().trim().min(1, 'escribe qué hay que hacer').max(200),
  description: z
    .string()
    .trim()
    .max(2000)
    .transform((v) => (v === '' ? null : v))
    .nullable()
    .optional(),
  /** Fecha y hora límite. Null: sin fecha. */
  dueAt: z.coerce.date().nullable().optional(),
  priority: z.enum(TASK_PRIORITIES).default('MEDIUM'),
  /** Quién la hace. Si no llega, quien la crea. */
  assigneeId: uuidSchema.nullable().optional(),
  /** Contacto al que pertenece. Tiene que estar dentro de tu alcance. */
  contactId: uuidSchema.nullable().optional(),
});
export type TaskCreateInput = z.infer<typeof taskCreateSchema>;

export const taskUpdateSchema = taskCreateSchema
  .extend({ status: z.enum(TASK_STATUSES) })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'no hay nada que cambiar');
export type TaskUpdateInput = z.infer<typeof taskUpdateSchema>;

/** Tramos por los que se agrupan las tareas en la pantalla de agenda. */
export const TASK_BUCKETS = ['overdue', 'today', 'upcoming', 'someday', 'done'] as const;
export type TaskBucket = (typeof TASK_BUCKETS)[number];

export const TASK_BUCKET_LABELS: Record<TaskBucket, string> = {
  overdue: 'Atrasadas',
  today: 'Para hoy',
  upcoming: 'Próximas',
  someday: 'Sin fecha',
  done: 'Hechas',
};

export const listTasksSchema = cursorPaginationSchema.extend({
  bucket: z.enum(TASK_BUCKETS).optional(),
  assigneeId: uuidSchema.optional(),
  /** Sólo las mías, sea cual sea el alcance del rol. */
  mine: z.coerce.boolean().optional(),
  contactId: uuidSchema.optional(),
  /**
   * Desplazamiento de la zona horaria del navegador, en minutos
   * (`Date.getTimezoneOffset()`): «hoy» depende de dónde esté quien mira.
   */
  tzOffset: z.coerce.number().int().min(-840).max(840).default(0),
});
export type ListTasksQuery = z.infer<typeof listTasksSchema>;

export interface TaskView {
  id: string;
  title: string;
  description: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  dueAt: string | null;
  completedAt: string | null;
  assignee: { id: string; name: string } | null;
  contact: { id: string; fullName: string } | null;
  createdAt: string;
}

/* ========================================================================== */
/*  Notas                                                                      */
/* ========================================================================== */

export const noteCreateSchema = z.object({
  body: z.string().trim().min(1, 'escribe la nota').max(5000),
  contactId: uuidSchema,
});
export type NoteCreateInput = z.infer<typeof noteCreateSchema>;

export const noteUpdateSchema = z.object({
  body: z.string().trim().min(1, 'escribe la nota').max(5000),
});
export type NoteUpdateInput = z.infer<typeof noteUpdateSchema>;

export interface NoteView {
  id: string;
  body: string;
  author: { id: string; name: string } | null;
  createdAt: string;
  updatedAt: string;
  /** La sesión actual puede editarla o borrarla (es suya, o gestiona el equipo). */
  canEdit: boolean;
}

/* ========================================================================== */
/*  Historia del contacto                                                      */
/* ========================================================================== */

export const ACTIVITY_TYPES = [
  'NOTE',
  'CALL',
  'EMAIL',
  'WHATSAPP',
  'MEETING',
  'TASK',
  'STAGE_CHANGE',
  'FIELD_CHANGE',
  'DOCUMENT',
  'PAYMENT',
  'AUTOMATION',
  'AI',
  'SYSTEM',
] as const;
export type ActivityType = (typeof ACTIVITY_TYPES)[number];

export interface ActivityView {
  id: string;
  type: ActivityType;
  title: string;
  summary: string | null;
  actor: { id: string; name: string } | null;
  occurredAt: string;
}
