/**
 * @nexo/contracts — el contrato entre la web, la API y el worker.
 *
 * Todo lo que cruza esa frontera se define aquí una sola vez: esquemas de
 * validación, permisos, forma de las respuestas. Si un campo cambia, lo que
 * se rompe es la compilación, no la aplicación en producción.
 */
export * from './common';
export * from './permissions';
export * from './env';
export * from './queues';
export * from './brand';
export * from './auth';
export * from './team';
export * from './crm';
export * from './tasks';
export * from './deals';
export * from './whatsapp';
export * from './inbox';
export * from './templates';
export * from './realtime';
export * from './files';
