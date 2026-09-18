/**
 * El cifrado en reposo vive en `@nexo/database`: también lo necesita el
 * worker, que envía los mensajes con el token del canal.
 */
export { decrypt, encrypt } from '@nexo/database';
