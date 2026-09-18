import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';
import {
  type ApiEnv,
  REALTIME_PREFIX,
  realtimeChannel,
  type RealtimeEvent,
  realtimeEventSchema,
} from '@nexo/contracts';
import Redis from 'ioredis';
import { API_ENV } from '../config/config.module';
import { REDIS } from '../redis/redis.module';
import { AccessService } from '../team/access.service';

/** Una conexión SSE abierta. */
export interface RealtimeClient {
  tenantId: string;
  membershipId: string;
  userId: string;
  send: (event: RealtimeEvent) => void;
  close: () => void;
}

/**
 * Avisos en tiempo real entre procesos.
 *
 * Quien cambia una conversación (la API o el worker) publica un aviso en
 * Redis, en el canal de su empresa. Cada proceso de la API está suscrito a
 * todos y reparte el aviso entre SUS conexiones abiertas de esa empresa,
 * comprobando antes que esa persona puede ver la conversación. Así funciona
 * igual con una instancia de la API que con diez detrás de un balanceador.
 *
 * Los permisos se comprueban EN VIVO en cada aviso (con la misma caché que
 * el resto de la API): a quien le quitan el acceso a mitad de una conexión se
 * le cierra en el siguiente aviso, no cuando caduque su token.
 */
@Injectable()
export class RealtimeService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger('Tiempo real');
  private readonly clients = new Map<string, Set<RealtimeClient>>();
  private subscriber: Redis | null = null;

  constructor(
    @Inject(API_ENV) private readonly env: ApiEnv,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly access: AccessService,
  ) {}

  async onModuleInit(): Promise<void> {
    // Conexión propia: una conexión suscrita no admite otros comandos.
    // Con cola sin conexión (a diferencia de la principal): si Redis cae, la
    // suscripción se rehace sola al volver.
    this.subscriber = new Redis(this.env.REDIS_URL, {
      connectionName: 'nexo-api-realtime',
      maxRetriesPerRequest: null,
      retryStrategy: (attempt) => Math.min(attempt * 250, 5_000),
    });
    this.subscriber.on('error', () => undefined);
    this.subscriber.on('pmessage', (_pattern, channel, message) => {
      void this.dispatch(channel.slice(REALTIME_PREFIX.length), message);
    });
    await this.subscriber.psubscribe(`${REALTIME_PREFIX}*`).catch((error: Error) => {
      this.logger.warn(`Suscripción pendiente hasta que Redis responda: ${error.message}`);
    });
  }

  async onApplicationShutdown(): Promise<void> {
    for (const set of this.clients.values()) for (const client of set) client.close();
    this.clients.clear();
    await this.subscriber?.quit().catch(() => this.subscriber?.disconnect());
  }

  /**
   * Publica un aviso. Nunca lanza: el cambio ya está guardado, y perder un
   * aviso sólo retrasa la pantalla hasta la siguiente recarga o reconexión.
   */
  async publish(tenantId: string, event: RealtimeEvent): Promise<void> {
    try {
      await this.redis.publish(realtimeChannel(tenantId), JSON.stringify(event));
    } catch (error) {
      this.logger.warn(`No se pudo publicar un aviso: ${(error as Error).message}`);
    }
  }

  register(client: RealtimeClient): () => void {
    let set = this.clients.get(client.tenantId);
    if (!set) {
      set = new Set();
      this.clients.set(client.tenantId, set);
    }
    set.add(client);
    return () => {
      set.delete(client);
      if (set.size === 0) this.clients.delete(client.tenantId);
    };
  }

  /** Conexiones abiertas en este proceso (para las pruebas y la sonda). */
  get connectionCount(): number {
    let total = 0;
    for (const set of this.clients.values()) total += set.size;
    return total;
  }

  private async dispatch(tenantId: string, raw: string): Promise<void> {
    const set = this.clients.get(tenantId);
    if (!set || set.size === 0) return;

    let event: RealtimeEvent;
    try {
      event = realtimeEventSchema.parse(JSON.parse(raw));
    } catch {
      this.logger.warn('Aviso con formato inválido descartado');
      return;
    }

    for (const client of [...set]) {
      try {
        const verdict = await this.canSee(client, event);
        if (verdict === 'revoked') client.close();
        else if (verdict) client.send(event);
      } catch (error) {
        this.logger.warn(`Aviso no entregado: ${(error as Error).message}`);
      }
    }
  }

  /**
   * ¿Puede esta conexión ver la conversación? Mismas reglas que la lista de
   * la bandeja: sin asignar la ve cualquiera con permiso; asignada, quien
   * tenga alcance sobre la persona asignada. Quien la acaba de perder también
   * recibe el aviso, para que desaparezca de su lista.
   */
  private async canSee(client: RealtimeClient, event: RealtimeEvent): Promise<boolean | 'revoked'> {
    const access = await this.access.resolve(client.tenantId, client.membershipId);
    if (!access || access.status !== 'ACTIVE' || access.userId !== client.userId) {
      return 'revoked';
    }
    const scope = access.permissions['conversation:read'];
    if (!scope) return 'revoked';
    if (scope === 'ALL') return true;

    // Sin asignar ahora, o hasta este cambio (null; `undefined` = no cambió):
    // la veía todo el que puede ver conversaciones.
    if (event.assigneeId === null || event.previousAssigneeId === null) return true;
    const involved = [event.assigneeId, event.previousAssigneeId].filter(
      (id): id is string => typeof id === 'string',
    );
    if (involved.includes(access.userId)) return true;
    if (scope === 'TEAM') {
      const team = await this.access.teamUserIds(access);
      return involved.some((id) => team.includes(id));
    }
    return false;
  }
}
