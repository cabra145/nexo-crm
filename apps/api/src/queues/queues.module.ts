import {
  Global,
  Inject,
  Injectable,
  Logger,
  Module,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { QUEUE_NAMES, QUEUE_POLICIES, type ApiEnv, type QueueName } from '@nexo/contracts';
import { Queue } from 'bullmq';
import { API_ENV } from '../config/config.module';
import { AuditService } from './audit.service';
import { MailService } from './mail.service';
import {
  AUDIT_QUEUE,
  EMAIL_QUEUE,
  WHATSAPP_INBOUND_QUEUE,
  WHATSAPP_OUTBOUND_QUEUE,
} from './queue-tokens';

/**
 * Colas en las que la API ENCOLA (el worker procesa).
 *
 * A BullMQ se le pasan opciones de conexión, no un cliente ya creado: así la
 * conexión es suya y `queue.close()` la cierra. Con un cliente prestado no la
 * cerraría, y mantendría vivo el proceso al apagar (el fallo de la prueba de
 * humo en la Fase 0).
 */
function createQueue(name: QueueName, env: ApiEnv): Queue {
  const policy = QUEUE_POLICIES[name];
  const url = new URL(env.REDIS_URL);
  return new Queue(name, {
    connection: {
      host: url.hostname,
      port: Number(url.port || 6379),
      password: url.password ? decodeURIComponent(url.password) : undefined,
      db: url.pathname.length > 1 ? Number(url.pathname.slice(1)) : undefined,
      // Encolar desde una petición HTTP tiene que fallar rápido si Redis cae,
      // no dejar la petición colgada.
      maxRetriesPerRequest: 2,
      enableOfflineQueue: false,
      connectionName: `nexo-api:${name}`,
    },
    defaultJobOptions: {
      attempts: policy.attempts,
      backoff: { type: 'exponential', delay: policy.backoffMs },
      removeOnComplete: { age: policy.keepCompleted.hours * 3600, count: policy.keepCompleted.max },
      removeOnFail: { age: policy.keepFailed.days * 86_400 },
    },
  });
}

@Injectable()
class QueuesLifecycle implements OnApplicationShutdown {
  private readonly logger = new Logger('Colas');

  constructor(
    @Inject(EMAIL_QUEUE) private readonly email: Queue,
    @Inject(AUDIT_QUEUE) private readonly audit: Queue,
    @Inject(WHATSAPP_INBOUND_QUEUE) private readonly whatsappInbound: Queue,
    @Inject(WHATSAPP_OUTBOUND_QUEUE) private readonly whatsappOutbound: Queue,
  ) {
    for (const queue of [email, audit, whatsappInbound, whatsappOutbound]) {
      queue.on('error', (error) => this.logger.warn(`Cola ${queue.name}: ${error.message}`));
    }
  }

  async onApplicationShutdown(): Promise<void> {
    await Promise.allSettled([
      this.email.close(),
      this.audit.close(),
      this.whatsappInbound.close(),
      this.whatsappOutbound.close(),
    ]);
  }
}

@Global()
@Module({
  providers: [
    {
      provide: EMAIL_QUEUE,
      inject: [API_ENV],
      useFactory: (env: ApiEnv) => createQueue(QUEUE_NAMES.EMAIL, env),
    },
    {
      provide: AUDIT_QUEUE,
      inject: [API_ENV],
      useFactory: (env: ApiEnv) => createQueue(QUEUE_NAMES.AUDIT, env),
    },
    {
      provide: WHATSAPP_INBOUND_QUEUE,
      inject: [API_ENV],
      useFactory: (env: ApiEnv) => createQueue(QUEUE_NAMES.WHATSAPP_INBOUND, env),
    },
    {
      provide: WHATSAPP_OUTBOUND_QUEUE,
      inject: [API_ENV],
      useFactory: (env: ApiEnv) => createQueue(QUEUE_NAMES.WHATSAPP_OUTBOUND, env),
    },
    QueuesLifecycle,
    MailService,
    AuditService,
  ],
  exports: [MailService, AuditService, WHATSAPP_INBOUND_QUEUE, WHATSAPP_OUTBOUND_QUEUE],
})
export class QueuesModule {}
