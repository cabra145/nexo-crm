import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import {
  type ApiEnv,
  countVariables,
  TEMPLATE_PROBLEMS,
  templateBlockedReason,
  templateBody,
  templateStatusOf,
  type TemplateSyncResult,
  type TemplateView,
} from '@nexo/contracts';
import { decrypt, Prisma, runInTenantTransaction } from '@nexo/database';
import { ProblemException } from '../common/problem.exception';
import { API_ENV } from '../config/config.module';
import { notFound } from '../team/team.problems';
import type { WhatsappCredentials } from './channels.service';
import { GraphClient, GraphError } from './graph.client';

const templateSelect = {
  id: true,
  name: true,
  language: true,
  category: true,
  status: true,
  components: true,
  rejectedReason: true,
  variables: true,
  updatedAt: true,
} satisfies Prisma.WaTemplateSelect;

type TemplateRow = Prisma.WaTemplateGetPayload<{ select: typeof templateSelect }>;

/**
 * Plantillas de mensaje: se sincronizan desde Meta y se leen para enviarlas.
 *
 * Nexo NO las crea ni las edita: se crean en el panel de Meta, que las revisa
 * y las aprueba. Aquí se guarda lo que Meta dice de ellas, y el webhook
 * mantiene el estado al día sin volver a preguntar.
 */
@Injectable()
export class TemplatesService {
  constructor(
    private readonly graph: GraphClient,
    @Inject(API_ENV) private readonly env: ApiEnv,
  ) {}

  /** Las de un canal, para quien administra: todas, con su estado. */
  async list(channelId: string): Promise<TemplateView[]> {
    const rows = await runInTenantTransaction(async (tx) => {
      const channel = await tx.channel.findUnique({
        where: { id: channelId },
        select: { id: true },
      });
      if (!channel) throw notFound('Canal');
      return tx.waTemplate.findMany({
        where: { channelId },
        select: templateSelect,
        orderBy: [{ name: 'asc' }, { language: 'asc' }],
      });
    });
    return rows.map(toView);
  }

  /**
   * Trae de Meta las plantillas del canal y las guarda.
   *
   * Se emparejan por (canal, nombre, idioma), que es como las identifica Meta:
   * la misma plantilla en español y en inglés son dos. Sincronizar dos veces
   * no duplica nada.
   */
  async sync(channelId: string): Promise<TemplateSyncResult> {
    const channel = await runInTenantTransaction((tx) =>
      tx.channel.findUnique({
        where: { id: channelId },
        select: {
          id: true,
          tenantId: true,
          status: true,
          config: true,
          credentialsEncrypted: true,
        },
      }),
    );
    if (!channel) throw notFound('Canal');
    const wabaId = (channel.config as { wabaId?: string } | null)?.wabaId;
    if (channel.status === 'DISABLED' || !channel.credentialsEncrypted || !wabaId) {
      throw new ProblemException({
        type: TEMPLATE_PROBLEMS.NO_WABA,
        title: 'El canal no está conectado del todo',
        status: HttpStatus.CONFLICT,
        detail: 'Vuelve a conectar el número en Ajustes → Canales para poder leer sus plantillas.',
      });
    }
    const { accessToken } = JSON.parse(
      decrypt(channel.credentialsEncrypted, this.env.ENCRYPTION_KEY),
    ) as WhatsappCredentials;

    let fromMeta;
    try {
      fromMeta = await this.graph.listTemplates(wabaId, accessToken);
    } catch (error) {
      if (!(error instanceof GraphError)) throw error;
      throw new ProblemException({
        type: TEMPLATE_PROBLEMS.NO_WABA,
        title: 'Meta no devolvió las plantillas',
        // 400 de Meta suele ser token sin permiso sobre la cuenta.
        status: error.status >= 500 ? HttpStatus.BAD_GATEWAY : HttpStatus.BAD_REQUEST,
        detail: error.message,
      });
    }

    const result = await runInTenantTransaction(async (tx) => {
      let created = 0;
      let updated = 0;
      for (const template of fromMeta) {
        const body = templateBody(template.components);
        const data = {
          category: (template.category ?? 'UTILITY').toUpperCase().slice(0, 30),
          status: templateStatusOf(template.status),
          externalId: template.id.slice(0, 120),
          rejectedReason: template.rejected_reason ?? null,
          components: (template.components ?? []) as Prisma.InputJsonValue,
          // Los nombres los pone Meta como {{1}}, {{2}}…: se guarda su orden.
          variables: Array.from({ length: countVariables(body) }, (_, i) => `${i + 1}`),
        };
        const existing = await tx.waTemplate.findFirst({
          where: { channelId, name: template.name, language: template.language },
          select: { id: true },
        });
        if (existing) {
          await tx.waTemplate.update({ where: { id: existing.id }, data });
          updated += 1;
        } else {
          await tx.waTemplate.create({
            data: {
              tenantId: channel.tenantId,
              channelId,
              name: template.name.slice(0, 120),
              language: template.language.slice(0, 10),
              ...data,
            },
          });
          created += 1;
        }
      }
      const templates = await tx.waTemplate.findMany({
        where: { channelId },
        select: templateSelect,
        orderBy: [{ name: 'asc' }, { language: 'asc' }],
      });
      return { created, updated, templates };
    });

    return {
      created: result.created,
      updated: result.updated,
      templates: result.templates.map(toView),
    };
  }

  /** Las que se pueden enviar HOY por un canal: aprobadas y sin variables raras. */
  async sendable(channelId: string): Promise<TemplateView[]> {
    const rows = await runInTenantTransaction((tx) =>
      tx.waTemplate.findMany({
        where: { channelId, status: 'APPROVED' },
        select: templateSelect,
        orderBy: [{ name: 'asc' }, { language: 'asc' }],
      }),
    );
    return rows.map(toView).filter((template) => template.sendable);
  }
}

/* ========================================================================== */

export function toView(row: TemplateRow): TemplateView {
  const body = templateBody(row.components);
  const blockedReason =
    row.status !== 'APPROVED'
      ? `Meta la tiene en estado ${row.status.toLowerCase()}`
      : templateBlockedReason(row.components);
  return {
    id: row.id,
    name: row.name,
    language: row.language,
    category: row.category,
    status: row.status,
    body,
    variableCount: countVariables(body),
    rejectedReason: row.rejectedReason,
    sendable: blockedReason === null,
    blockedReason,
    updatedAt: row.updatedAt.toISOString(),
  };
}
