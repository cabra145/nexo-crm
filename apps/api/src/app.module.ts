import { randomUUID } from 'node:crypto';
import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import type { ApiEnv } from '@nexo/contracts';
import { LoggerModule } from 'nestjs-pino';
import { ProblemDetailsFilter } from './common/filters/problem-details.filter';
import { API_ENV, ConfigModule } from './config/config.module';
import { DatabaseModule } from './database/database.module';
import { HealthModule } from './health/health.module';
import { RedisModule } from './redis/redis.module';

/** Un id de petición entrante sólo se acepta si tiene forma razonable. */
const INCOMING_TRACE_ID = /^[A-Za-z0-9_-]{8,64}$/;

@Module({
  imports: [
    ConfigModule,

    // --- Registro estructurado ---------------------------------------------
    LoggerModule.forRootAsync({
      imports: [ConfigModule],
      inject: [API_ENV],
      useFactory: (env: ApiEnv) => ({
        pinoHttp: {
          level: env.LOG_LEVEL,

          // El id de traza viaja en la cabecera X-Trace-Id de la respuesta y
          // en el `traceId` de cada error, así que un usuario puede darle a
          // soporte exactamente la línea de log que corresponde a su fallo.
          // Si Nginx (o el cliente) ya trae un X-Request-Id, se respeta para
          // poder seguir la petición de punta a punta.
          genReqId: (req, res) => {
            const incoming = req.headers['x-request-id'];
            const id =
              typeof incoming === 'string' && INCOMING_TRACE_ID.test(incoming)
                ? incoming
                : randomUUID();
            res.setHeader('X-Trace-Id', id);
            return id;
          },

          customProps: () => ({ service: 'api' }),

          // Nada de credenciales en los logs, jamás.
          redact: {
            paths: [
              'req.headers.authorization',
              'req.headers.cookie',
              'res.headers["set-cookie"]',
            ],
            censor: '[redactado]',
          },

          serializers: {
            req: (req: { id: string; method: string; url: string }) => ({
              id: req.id,
              method: req.method,
              url: req.url,
            }),
            res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
          },

          // Las sondas de salud se llaman cada pocos segundos: registrarlas
          // sepultaría todo lo demás.
          autoLogging: {
            ignore: (req) => req.url?.startsWith('/api/v1/health') ?? false,
          },

          // Legible en desarrollo, JSON en producción (lo consume el agregador
          // de logs). La ruta se resuelve aquí porque con la estructura
          // estricta de pnpm, pino no encontraría `pino-pretty` por su nombre.
          transport:
            env.NODE_ENV === 'development'
              ? {
                  target: require.resolve('pino-pretty'),
                  options: {
                    colorize: true,
                    singleLine: true,
                    translateTime: 'HH:MM:ss',
                    ignore: 'pid,hostname,service',
                  },
                }
              : undefined,
        },
      }),
    }),

    // --- Límite de tasa ----------------------------------------------------
    // Almacén en memoria: correcto mientras la API corra en UNA instancia,
    // que es el despliegue de arranque aprobado. Al escalar a varias réplicas
    // hay que pasarlo a Redis, o cada réplica llevaría su propio contador y
    // el límite real se multiplicaría por el número de instancias.
    ThrottlerModule.forRootAsync({
      imports: [ConfigModule],
      inject: [API_ENV],
      useFactory: (env: ApiEnv) => ({
        throttlers: [{ ttl: env.RATE_LIMIT_WINDOW_MS, limit: env.RATE_LIMIT_MAX }],
      }),
    }),

    DatabaseModule,
    RedisModule,
    HealthModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_FILTER, useClass: ProblemDetailsFilter },
  ],
})
export class AppModule {}
