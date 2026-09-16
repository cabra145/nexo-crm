import {
  Global,
  Inject,
  Injectable,
  Logger,
  Module,
  type OnApplicationShutdown,
} from '@nestjs/common';
import type { ApiEnv } from '@nexo/contracts';
import Redis from 'ioredis';
import { API_ENV } from '../config/config.module';

/** Token de inyección del cliente de Redis: `@Inject(REDIS) redis: Redis`. */
export const REDIS = Symbol('REDIS');

function createRedisClient(env: ApiEnv): Redis {
  const logger = new Logger('Redis');

  const client = new Redis(env.REDIS_URL, {
    // Falla rápido en vez de encolar comandos en memoria mientras Redis está
    // caído: una comprobación de salud tiene que decir "caído" en el acto, no
    // quedarse colgada hasta que vuelva.
    enableOfflineQueue: false,
    maxRetriesPerRequest: 2,
    // Reintento con espera creciente, hasta 5 s entre intentos. Nunca se
    // rinde: si Redis vuelve, la API se recupera sola sin reiniciarla.
    retryStrategy: (attempt) => Math.min(attempt * 250, 5_000),
    connectionName: 'nexo-api',
  });

  // ioredis emite un error por CADA reintento. Con Redis caído eso son
  // decenas de líneas por minuto que entierran todo lo demás. Se avisa una vez
  // al caer y otra al recuperarse.
  let degraded = false;

  client.on('ready', () => {
    logger.log(degraded ? 'Conexión con Redis recuperada' : 'Conectado a Redis');
    degraded = false;
  });

  client.on('error', (error) => {
    if (degraded) return;
    degraded = true;
    logger.warn(
      `Sin conexión con Redis (${error.message}). Reintentando en segundo plano; ` +
        '¿está levantado Docker? → docker compose --env-file .env -f infra/compose.yml up -d',
    );
  });

  return client;
}

@Injectable()
class RedisLifecycle implements OnApplicationShutdown {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  async onApplicationShutdown(): Promise<void> {
    // `quit` espera a que terminen los comandos en curso; `disconnect` los
    // cortaría. Si Redis ya no responde, se corta igualmente.
    await this.redis.quit().catch(() => this.redis.disconnect());
  }
}

@Global()
@Module({
  providers: [
    { provide: REDIS, inject: [API_ENV], useFactory: createRedisClient },
    RedisLifecycle,
  ],
  exports: [REDIS],
})
export class RedisModule {}
