import { randomBytes } from 'node:crypto';
import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import {
  type ApiEnv,
  type ChannelView,
  type ConnectWhatsappInput,
  WHATSAPP_PROBLEMS,
} from '@nexo/contracts';
import { Prisma, runInTenantTransaction } from '@nexo/database';
import type { Request } from 'express';
import { decrypt, encrypt } from '../common/crypto/encryption';
import { ProblemException } from '../common/problem.exception';
import { traceIdOf } from '../common/trace-id';
import { API_ENV } from '../config/config.module';
import { AuditService } from '../queues/audit.service';
import type { ResolvedAccess } from '../team/access.service';
import { loadPlanLimits, lockResource } from '../team/plan-limits';
import { notFound } from '../team/team.problems';
import { GraphClient, GraphError } from './graph.client';

/** Lo que se guarda cifrado en `channel.credentials_encrypted`. */
export interface WhatsappCredentials {
  accessToken: string;
  appSecret: string;
}

interface ChannelConfig {
  wabaId?: string;
  verifiedName?: string | null;
}

const channelSelect = {
  id: true,
  name: true,
  status: true,
  displayId: true,
  externalId: true,
  config: true,
  webhookSecretEncrypted: true,
  connectedAt: true,
  lastErrorAt: true,
  lastErrorMessage: true,
} satisfies Prisma.ChannelSelect;

type ChannelRow = Prisma.ChannelGetPayload<{ select: typeof channelSelect }>;

/**
 * Canales de WhatsApp de la empresa.
 *
 * Conectar comprueba primero, contra Meta, que el token da acceso al número:
 * un canal que parece conectado pero no recibe nada es peor que un error al
 * darlo de alta. Las credenciales se guardan cifradas (AES-256-GCM) y NUNCA
 * vuelven al navegador; lo único que se muestra es lo que la empresa tiene
 * que copiar en Meta: la URL del webhook y su token de verificación.
 */
@Injectable()
export class ChannelsService {
  constructor(
    private readonly graph: GraphClient,
    private readonly audit: AuditService,
    @Inject(API_ENV) private readonly env: ApiEnv,
  ) {}

  async list(): Promise<ChannelView[]> {
    const rows = await runInTenantTransaction((tx) =>
      tx.channel.findMany({
        where: { type: 'WHATSAPP_CLOUD', status: { not: 'DISABLED' } },
        select: channelSelect,
        orderBy: { id: 'asc' },
      }),
    );
    return rows.map((row) => this.toView(row));
  }

  async connect(
    access: ResolvedAccess,
    input: ConnectWhatsappInput,
    req: Request,
  ): Promise<ChannelView> {
    // Primero Meta: si el token no vale, no se guarda nada.
    let phone: Awaited<ReturnType<GraphClient['getPhoneNumber']>>;
    try {
      phone = await this.graph.getPhoneNumber(input.phoneNumberId, input.accessToken);
    } catch (error) {
      if (!(error instanceof GraphError)) throw error;
      throw new ProblemException({
        type: WHATSAPP_PROBLEMS.META_REJECTED,
        title: 'Meta no aceptó la conexión',
        status: HttpStatus.BAD_REQUEST,
        detail: `Meta respondió: «${error.message}». Revisa el identificador del número y que el token tenga el permiso whatsapp_business_messaging.`,
        errors: [{ field: 'accessToken', message: 'Meta lo rechazó' }],
      });
    }

    const verifyToken = randomBytes(24).toString('base64url');
    const credentials: WhatsappCredentials = {
      accessToken: input.accessToken,
      appSecret: input.appSecret,
    };

    const row = await runInTenantTransaction(async (tx) => {
      await lockResource(tx, `nexo:channels:${access.tenantId}`);
      const { maxChannels } = await loadPlanLimits(tx);
      const used = await tx.channel.count({ where: { status: { not: 'DISABLED' } } });
      if (maxChannels !== null && used >= maxChannels) {
        throw new ProblemException({
          type: WHATSAPP_PROBLEMS.CHANNEL_QUOTA,
          title: 'Tu plan no admite más canales',
          status: HttpStatus.FORBIDDEN,
          detail:
            maxChannels === 0
              ? 'Tu plan no incluye canales de mensajería. Mejóralo para conectar WhatsApp.'
              : `Tu plan incluye ${maxChannels} canal(es). Desconecta uno o mejora el plan.`,
        });
      }

      try {
        return await tx.channel.create({
          data: {
            tenantId: access.tenantId,
            type: 'WHATSAPP_CLOUD',
            name: input.name,
            status: 'CONNECTED',
            externalId: input.phoneNumberId,
            displayId: normalizeDisplay(phone.displayPhoneNumber),
            credentialsEncrypted: encrypt(JSON.stringify(credentials), this.env.ENCRYPTION_KEY),
            webhookSecretEncrypted: encrypt(verifyToken, this.env.ENCRYPTION_KEY),
            config: { wabaId: input.wabaId, verifiedName: phone.verifiedName },
            connectedAt: new Date(),
          },
          select: channelSelect,
        });
      } catch (error) {
        // El número es único entre TODAS las empresas: un webhook de Meta tiene
        // que ir a parar a un único sitio. No se dice en cuál está.
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
          throw new ProblemException({
            type: WHATSAPP_PROBLEMS.NUMBER_IN_USE,
            title: 'Ese número ya está conectado',
            status: HttpStatus.CONFLICT,
            detail:
              'Este número de WhatsApp ya está conectado en Nexo. Desconéctalo allí antes de conectarlo aquí.',
            errors: [{ field: 'phoneNumberId', message: 'ya está en uso' }],
          });
        }
        throw error;
      }
    });

    await this.audit.record({
      tenantId: access.tenantId,
      actorUserId: access.userId,
      action: 'CREATE',
      resourceType: 'Channel',
      resourceId: row.id,
      resourceLabel: `${row.name} (${row.displayId ?? input.phoneNumberId})`,
      ip: req.ip,
      userAgent: req.headers['user-agent']?.slice(0, 500),
      traceId: traceIdOf(req),
    });
    return this.toView(row);
  }

  /**
   * Desconectar borra las credenciales y libera el número (para poder
   * conectarlo en otra empresa), pero conserva el canal y sus conversaciones:
   * el historial de lo que se habló no se pierde por desconectar.
   */
  async disconnect(access: ResolvedAccess, id: string, req: Request): Promise<void> {
    const row = await runInTenantTransaction(async (tx) => {
      const channel = await tx.channel.findFirst({
        where: { id, status: { not: 'DISABLED' } },
        select: channelSelect,
      });
      if (!channel) throw notFound('Canal');
      await tx.channel.update({
        where: { id },
        data: {
          status: 'DISABLED',
          externalId: null,
          credentialsEncrypted: null,
          webhookSecretEncrypted: null,
        },
      });
      return channel;
    });

    await this.audit.record({
      tenantId: access.tenantId,
      actorUserId: access.userId,
      action: 'DELETE',
      resourceType: 'Channel',
      resourceId: row.id,
      resourceLabel: `${row.name} (${row.displayId ?? ''})`,
      ip: req.ip,
      userAgent: req.headers['user-agent']?.slice(0, 500),
      traceId: traceIdOf(req),
    });
  }

  webhookUrl(channelId: string): string {
    const base = this.env.API_PUBLIC_URL ?? `http://localhost:${this.env.API_PORT}`;
    return `${base.replace(/\/$/, '')}/api/v1/webhooks/whatsapp/${channelId}`;
  }

  private toView(row: ChannelRow): ChannelView {
    const config = (row.config ?? {}) as ChannelConfig;
    return {
      id: row.id,
      type: 'WHATSAPP_CLOUD',
      name: row.name,
      status: row.status,
      displayId: row.displayId,
      verifiedName: config.verifiedName ?? null,
      phoneNumberId: row.externalId,
      webhookUrl: this.webhookUrl(row.id),
      verifyToken: row.webhookSecretEncrypted
        ? decrypt(row.webhookSecretEncrypted, this.env.ENCRYPTION_KEY)
        : '',
      connectedAt: row.connectedAt?.toISOString() ?? null,
      lastErrorAt: row.lastErrorAt?.toISOString() ?? null,
      lastErrorMessage: row.lastErrorMessage,
    };
  }
}

/** Meta devuelve el número con espacios y guiones («+593 98 765 4321»). */
function normalizeDisplay(value: string): string {
  const digits = value.replace(/\D/g, '');
  return digits ? `+${digits}` : value;
}
