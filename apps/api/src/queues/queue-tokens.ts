/**
 * Tokens de inyección de las colas, en su propio archivo.
 *
 * Si vivieran en queues.module.ts, los servicios que los importan y el módulo
 * que importa a esos servicios formarían un ciclo, y en CommonJS uno de los
 * dos vería el token como `undefined` al arrancar.
 */
export const EMAIL_QUEUE = Symbol('EMAIL_QUEUE');
export const AUDIT_QUEUE = Symbol('AUDIT_QUEUE');
export const WHATSAPP_INBOUND_QUEUE = Symbol('WHATSAPP_INBOUND_QUEUE');
