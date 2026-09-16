import pino from 'pino';
import { env } from '../bootstrap/env';

/**
 * Logger estructurado del worker. Mismo formato que la API, para que en el
 * agregador de logs se puedan cruzar por `traceId`: la petición que encoló un
 * trabajo y el trabajo que lo procesó comparten identificador.
 */
export const logger = pino({
  level: env.LOG_LEVEL,
  base: { service: 'worker' },
  redact: {
    paths: ['*.password', '*.token', '*.secret', '*.html', '*.text'],
    censor: '[redactado]',
  },
  transport:
    env.NODE_ENV === 'development'
      ? {
          // Ruta resuelta aquí: con la estructura estricta de pnpm, pino no
          // encontraría `pino-pretty` por su nombre.
          target: require.resolve('pino-pretty'),
          options: {
            colorize: true,
            singleLine: true,
            translateTime: 'HH:MM:ss',
            ignore: 'pid,hostname,service',
          },
        }
      : undefined,
});

export type Logger = typeof logger;

/**
 * "lucia.benitez@acme.test" → "l***@acme.test".
 *
 * Los destinatarios de correo son datos personales: el log sólo necesita
 * saber a qué dominio fue, para diagnosticar problemas de entrega.
 */
export function maskEmail(address: string): string {
  const at = address.indexOf('@');
  if (at <= 0) return '***';
  return `${address[0]}***${address.slice(at)}`;
}
