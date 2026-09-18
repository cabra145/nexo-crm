import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { type ApiEnv, PROBLEM_TYPES, type WhatsappInboundJob } from '@nexo/contracts';
import { Prisma, platformPrisma, runAsWebhookChannel } from '@nexo/database';
import type { Queue } from 'bullmq';
import { decrypt } from '../common/crypto/encryption';
import { ProblemException } from '../common/problem.exception';
import { API_ENV } from '../config/config.module';
import { WHATSAPP_INBOUND_QUEUE } from '../queues/queue-tokens';
import type { WhatsappCredentials } from './channels.service';

interface WebhookChannel {
  id: string;
  tenantId: string;
  verifyToken: string;
  appSecret: string;
}

/**
 * Entrada de los webhooks de Meta.
 *
 * Lo único que se hace aquí es comprobar que el evento es auténtico y
 * ponerlo a salvo: se guarda en `webhook_event` y se encola. Meta espera una
 * respuesta rápida y reintenta si no la recibe; si el procesamiento (crear el
 * contacto, la conversación, el mensaje) fuera en línea, un pico de mensajes o
 * una base lenta haría que Meta reenviara eventos que en realidad sí llegaron.
 *
 * La URL lleva el id del canal: con él se averigua su empresa y su secreto
 * de firma mediante la identidad `app.webhook_channel_id` (ver 01_rls.sql, 3c),
 * sin privilegios especiales.
 */
@Injectable()
export class WebhookService {
  private readonly logger = new Logger('Webhook WhatsApp');

  constructor(
    @Inject(WHATSAPP_INBOUND_QUEUE) private readonly queue: Queue,
    @Inject(API_ENV) private readonly env: ApiEnv,
  ) {}

  /** Alta del webhook en Meta: devuelve el reto si el token coincide. */
  async verify(
    channelId: string,
    mode: string | undefined,
    token: string | undefined,
    challenge: string | undefined,
  ): Promise<string> {
    const channel = await this.channel(channelId);
    if (mode !== 'subscribe' || !token || !challenge || !safeEqual(token, channel.verifyToken)) {
      throw new ProblemException({
        type: PROBLEM_TYPES.FORBIDDEN,
        title: 'Token de verificación incorrecto',
        status: HttpStatus.FORBIDDEN,
        detail: 'El token no coincide con el que muestra Nexo para este canal.',
      });
    }
    return challenge;
  }

  /**
   * Recibe un evento. Devuelve si era nuevo o un reenvío de uno ya recibido
   * (Meta reintenta; los reintentos SÍ ocurren).
   */
  async receive(
    channelId: string,
    rawBody: Buffer | undefined,
    signature: string | undefined,
  ): Promise<'nuevo' | 'repetido'> {
    const channel = await this.channel(channelId);
    if (!rawBody || !signature || !validSignature(rawBody, signature, channel.appSecret)) {
      // Sin detalles: quien prueba firmas no necesita saber cuál de las
      // condiciones falló.
      throw new ProblemException({
        type: PROBLEM_TYPES.UNAUTHORIZED,
        title: 'Firma no válida',
        status: HttpStatus.UNAUTHORIZED,
      });
    }

    let payload: unknown;
    try {
      payload = JSON.parse(rawBody.toString('utf8'));
    } catch {
      throw new ProblemException({
        type: PROBLEM_TYPES.VALIDATION,
        title: 'El cuerpo no es JSON',
        status: HttpStatus.BAD_REQUEST,
      });
    }

    // Mismo cuerpo = mismo evento: la huella del cuerpo es el identificador
    // que hace idempotente la recepción.
    const eventId = createHash('sha256').update(rawBody).digest('hex');
    let webhookEventId: string;
    try {
      const created = await platformPrisma.webhookEvent.create({
        data: {
          provider: 'meta',
          eventId,
          eventType: 'whatsapp',
          tenantId: channel.tenantId,
          channelId: channel.id,
          payload: payload as Prisma.InputJsonValue,
          signature: signature.slice(0, 200),
        },
        select: { id: true },
      });
      webhookEventId = created.id;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        return 'repetido';
      }
      throw error;
    }

    const job: WhatsappInboundJob = {
      webhookEventId,
      tenantId: channel.tenantId,
      channelId: channel.id,
    };
    try {
      await this.queue.add('evento', job, { jobId: webhookEventId });
    } catch (error) {
      // Queda en `webhook_event` como PENDING: no se pierde. Se registra para
      // poder reencolarlo; a Meta se le responde igual, porque el evento sí
      // está guardado.
      this.logger.error(
        `No se pudo encolar el evento ${webhookEventId}: ${(error as Error).message}`,
      );
    }
    return 'nuevo';
  }

  private async channel(channelId: string): Promise<WebhookChannel> {
    const row = await runAsWebhookChannel(channelId, (tx) =>
      tx.channel.findUnique({
        where: { id: channelId },
        select: {
          id: true,
          tenantId: true,
          type: true,
          status: true,
          credentialsEncrypted: true,
          webhookSecretEncrypted: true,
        },
      }),
    );
    if (
      !row ||
      row.type !== 'WHATSAPP_CLOUD' ||
      row.status === 'DISABLED' ||
      !row.credentialsEncrypted ||
      !row.webhookSecretEncrypted
    ) {
      throw new ProblemException({
        type: PROBLEM_TYPES.NOT_FOUND,
        title: 'Canal no encontrado',
        status: HttpStatus.NOT_FOUND,
      });
    }
    const credentials = JSON.parse(
      decrypt(row.credentialsEncrypted, this.env.ENCRYPTION_KEY),
    ) as WhatsappCredentials;
    return {
      id: row.id,
      tenantId: row.tenantId,
      verifyToken: decrypt(row.webhookSecretEncrypted, this.env.ENCRYPTION_KEY),
      appSecret: credentials.appSecret,
    };
  }
}

/** Comparación en tiempo constante: no revela por tiempos cuántos caracteres acertó. */
function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * `X-Hub-Signature-256: sha256=<hex>`: HMAC-SHA256 del cuerpo EXACTO que llegó,
 * con la clave secreta de la app. Por eso hace falta el cuerpo crudo: volver a
 * serializar el JSON cambiaría los bytes y la firma no coincidiría.
 */
function validSignature(rawBody: Buffer, header: string, appSecret: string): boolean {
  if (!header.startsWith('sha256=')) return false;
  const expected = createHmac('sha256', appSecret).update(rawBody).digest('hex');
  return safeEqual(header.slice('sha256='.length), expected);
}
