import type { IncomingMessage } from 'node:http';

/**
 * Identificador de traza de una petición, como texto.
 *
 * pino-http tipa `req.id` como `string | number | object`. Nosotros siempre lo
 * generamos como UUID (app.module.ts · genReqId), pero convertir un objeto a
 * texto daría "[object Object]" en la auditoría, así que se comprueba en vez de
 * suponerlo. Recortado a 40: el tamaño de audit_log.trace_id.
 */
export function traceIdOf(req: IncomingMessage): string | undefined {
  const id = (req as IncomingMessage & { id?: unknown }).id;
  return typeof id === 'string' || typeof id === 'number' ? String(id).slice(0, 40) : undefined;
}
