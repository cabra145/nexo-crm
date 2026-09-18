import { z } from 'zod';
import { currencySchema, moneySchema, uuidSchema } from './common';

/**
 * Contrato del embudo de ventas: oportunidades y su tablero.
 *
 * Las oportunidades tienen responsable (`ownerId`), así que el alcance del rol
 * se aplica sobre ese campo, igual que en contactos y tareas.
 */

export const DEAL_STATUSES = ['OPEN', 'WON', 'LOST'] as const;
export type DealStatus = (typeof DEAL_STATUSES)[number];

export const STAGE_TYPES = ['OPEN', 'WON', 'LOST'] as const;
export type StageType = (typeof STAGE_TYPES)[number];

/* ========================================================================== */
/*  Peticiones                                                                 */
/* ========================================================================== */

export const dealCreateSchema = z.object({
  title: z.string().trim().min(1, 'escribe de qué va la oportunidad').max(200),
  /** Embudo. Si no llega, el que la empresa tenga por defecto. */
  pipelineId: uuidSchema.optional(),
  /** Etapa inicial. Si no llega, la primera del embudo. */
  stageId: uuidSchema.optional(),
  contactId: uuidSchema.nullable().optional(),
  companyId: uuidSchema.nullable().optional(),
  ownerId: uuidSchema.nullable().optional(),
  value: moneySchema.default(0),
  currency: currencySchema.optional(),
  probability: z.coerce.number().int().min(0).max(100).optional(),
  expectedCloseAt: z.coerce.date().nullable().optional(),
});
export type DealCreateInput = z.infer<typeof dealCreateSchema>;

export const dealUpdateSchema = dealCreateSchema
  .omit({ pipelineId: true, stageId: true })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'no hay nada que cambiar');
export type DealUpdateInput = z.infer<typeof dealUpdateSchema>;

/**
 * Mover una tarjeta: a qué etapa y entre qué dos vecinas.
 *
 * La posición no la calcula el cliente: manda los ids de las tarjetas entre
 * las que suelta, y el servidor decide el número. Así dos personas moviendo a
 * la vez no se pisan, y el cliente no necesita saber cómo se ordenan.
 */
export const dealMoveSchema = z.object({
  stageId: uuidSchema,
  /** Tarjeta que queda ENCIMA de la soltada. Null: va al principio. */
  afterDealId: uuidSchema.nullable().optional(),
  /** Tarjeta que queda DEBAJO. Null: va al final. */
  beforeDealId: uuidSchema.nullable().optional(),
});
export type DealMoveInput = z.infer<typeof dealMoveSchema>;

export const dealWinSchema = z.object({
  value: moneySchema.optional(),
});

export const dealLoseSchema = z.object({
  lostReasonId: uuidSchema.nullable().optional(),
  note: z
    .string()
    .trim()
    .max(500)
    .transform((v) => (v === '' ? null : v))
    .nullable()
    .optional(),
});
export type DealLoseInput = z.infer<typeof dealLoseSchema>;

export const boardQuerySchema = z.object({
  pipelineId: uuidSchema.optional(),
  /** Sólo las mías, sea cual sea el alcance del rol. */
  mine: z.coerce.boolean().optional(),
  /** Tarjetas por columna. El tablero no es un listado: se ve de un vistazo. */
  perStage: z.coerce.number().int().min(5).max(100).default(50),
});
export type BoardQuery = z.infer<typeof boardQuerySchema>;

/* ========================================================================== */
/*  Respuestas                                                                 */
/* ========================================================================== */

export interface StageView {
  id: string;
  name: string;
  type: StageType;
  color: string;
  probability: number;
  position: number;
  rottingDays: number | null;
}

export interface PipelineView {
  id: string;
  name: string;
  isDefault: boolean;
  stages: StageView[];
}

export interface DealCard {
  id: string;
  title: string;
  value: number;
  currency: string;
  probability: number;
  status: DealStatus;
  stageId: string;
  position: number;
  contact: { id: string; fullName: string } | null;
  company: { id: string; name: string } | null;
  owner: { id: string; name: string } | null;
  expectedCloseAt: string | null;
  /** Lleva demasiado tiempo parada en su etapa (según `rottingDays`). */
  stalled: boolean;
  stageEnteredAt: string;
  createdAt: string;
}

export interface BoardColumn {
  stage: StageView;
  deals: DealCard[];
  /** Totales de la columna ENTERA, aunque se muestren menos tarjetas. */
  totalCount: number;
  totalValue: number;
}

export interface BoardView {
  pipeline: PipelineView;
  pipelines: Array<{ id: string; name: string }>;
  columns: BoardColumn[];
  currency: string;
}

export interface DealStageStep {
  stageId: string;
  stageName: string;
  enteredAt: string;
  exitedAt: string | null;
  durationSeconds: number | null;
}

export interface DealDetail extends DealCard {
  pipelineId: string;
  stageName: string;
  closedAt: string | null;
  lostReason: { id: string; name: string } | null;
  lostReasonNote: string | null;
  history: DealStageStep[];
}

export interface LostReasonView {
  id: string;
  name: string;
}

export const DEAL_PROBLEMS = {
  /** La oportunidad ya está ganada o perdida: para moverla, hay que reabrirla. */
  DEAL_CLOSED: 'https://nexo.app/problems/oportunidad-cerrada',
} as const;
