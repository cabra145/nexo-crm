import { z } from 'zod';

/**
 * Plantillas de mensaje de WhatsApp.
 *
 * Fuera de la ventana de 24 h, Meta sólo deja escribir con una plantilla que
 * él mismo haya aprobado. Las plantillas se crean en el panel de Meta y aquí
 * se SINCRONIZAN: Nexo no las crea ni las edita, porque cada cambio pasa por
 * una revisión de Meta que puede tardar horas.
 */

export const TEMPLATE_STATUSES = [
  'DRAFT',
  'PENDING',
  'APPROVED',
  'REJECTED',
  'PAUSED',
  'DISABLED',
] as const;
export type TemplateStatus = (typeof TEMPLATE_STATUSES)[number];

/** Estado de Meta → estado de Nexo. Lo que no reconozcamos queda en DRAFT. */
export function templateStatusOf(metaStatus: string): TemplateStatus {
  const normalized = metaStatus.trim().toUpperCase();
  switch (normalized) {
    case 'APPROVED':
      return 'APPROVED';
    case 'PENDING':
    case 'IN_APPEAL':
    case 'PENDING_DELETION':
      return 'PENDING';
    case 'REJECTED':
      return 'REJECTED';
    case 'PAUSED':
      return 'PAUSED';
    case 'DISABLED':
    case 'DELETED':
      return 'DISABLED';
    default:
      return 'DRAFT';
  }
}

export interface TemplateView {
  id: string;
  name: string;
  language: string;
  category: string;
  status: TemplateStatus;
  /** Texto del cuerpo tal como lo devuelve Meta, con `{{1}}`, `{{2}}`… */
  body: string;
  /** Cuántas variables tiene el cuerpo. */
  variableCount: number;
  rejectedReason: string | null;
  /** ¿Se puede enviar desde Nexo hoy? */
  sendable: boolean;
  /** Por qué no, si no se puede. */
  blockedReason: string | null;
  updatedAt: string;
}

export interface TemplateSyncResult {
  /** Plantillas que tiene el canal tras sincronizar. */
  templates: TemplateView[];
  created: number;
  updated: number;
}

/* ========================================================================== */
/*  Lo que Nexo sabe enviar                                                    */
/* ========================================================================== */

/**
 * De momento sólo se envían plantillas cuyas variables estén TODAS en el
 * cuerpo. Meta trata aparte las de la cabecera (texto, imagen, documento) y
 * las de los botones, y cada una añade sus propios casos. Las demás se listan,
 * pero marcadas con su motivo: es mejor decir por qué no se puede que
 * ofrecer un envío que Meta rechazaría.
 */
export function templateBlockedReason(components: unknown): string | null {
  const list = Array.isArray(components) ? (components as Array<Record<string, unknown>>) : [];
  const body = list.find((c) => String(c.type).toUpperCase() === 'BODY');
  if (!body || typeof body.text !== 'string' || body.text.trim() === '') {
    return 'La plantilla no tiene cuerpo de texto';
  }
  const header = list.find((c) => String(c.type).toUpperCase() === 'HEADER');
  if (header) {
    const format = (typeof header.format === 'string' ? header.format : 'TEXT').toUpperCase();
    if (format !== 'TEXT') {
      return `Su cabecera es de tipo ${format.toLowerCase()}, que Nexo todavía no envía`;
    }
    if (typeof header.text === 'string' && countVariables(header.text) > 0) {
      return 'Su cabecera lleva variables, que Nexo todavía no envía';
    }
  }
  const buttons = list.find((c) => String(c.type).toUpperCase() === 'BUTTONS');
  if (buttons && hasButtonVariables(buttons)) {
    return 'Sus botones llevan variables, que Nexo todavía no envía';
  }
  return null;
}

function hasButtonVariables(buttons: Record<string, unknown>): boolean {
  const list = Array.isArray(buttons.buttons) ? (buttons.buttons as Record<string, unknown>[]) : [];
  return list.some(
    (button) =>
      (typeof button.url === 'string' && countVariables(button.url) > 0) ||
      (typeof button.text === 'string' && countVariables(button.text) > 0),
  );
}

/** Texto del cuerpo de una plantilla, o cadena vacía. */
export function templateBody(components: unknown): string {
  const list = Array.isArray(components) ? (components as Array<Record<string, unknown>>) : [];
  const body = list.find((c) => String(c.type).toUpperCase() === 'BODY');
  return typeof body?.text === 'string' ? body.text : '';
}

/**
 * Número de variables del cuerpo. Meta las numera desde 1 y permite repetirlas
 * (`{{1}}` dos veces), así que cuenta la MAYOR, no cuántas aparecen.
 */
export function countVariables(text: string): number {
  let max = 0;
  for (const match of text.matchAll(/\{\{\s*(\d+)\s*\}\}/g)) {
    max = Math.max(max, Number(match[1]));
  }
  return max;
}

/** Sustituye `{{1}}`, `{{2}}`… por los valores dados, para la vista previa. */
export function renderTemplate(text: string, variables: string[]): string {
  return text.replace(/\{\{\s*(\d+)\s*\}\}/g, (whole, index: string) => {
    const value = variables[Number(index) - 1];
    return value === undefined || value === '' ? whole : value;
  });
}

/* ========================================================================== */
/*  Entradas                                                                   */
/* ========================================================================== */

/** Valor de una variable: sin saltos de línea ni tabulaciones (Meta los rechaza). */
export const templateVariableSchema = z
  .string()
  .trim()
  .min(1, 'rellena todas las variables')
  .max(1024, 'máximo 1024 caracteres')
  .refine((v) => !/[\n\r\t]/.test(v), 'sin saltos de línea ni tabulaciones');

export const TEMPLATE_PROBLEMS = {
  /** La plantilla no está aprobada, o Nexo aún no sabe enviarla. */
  NOT_SENDABLE: 'https://nexo.app/problems/plantilla-no-enviable',
  /** El canal no tiene cuenta de WhatsApp Business guardada. */
  NO_WABA: 'https://nexo.app/problems/canal-sin-cuenta-de-whatsapp',
} as const;
