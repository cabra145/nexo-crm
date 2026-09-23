import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import type { ApiEnv } from '@nexo/contracts';
import {
  allowsCaption,
  canSend,
  checkMedia,
  countVariables,
  dispositionFor,
  type ConversationCounts,
  type ConversationDetail,
  type ConversationList,
  type ConversationListQuery,
  type ConversationSummary,
  INBOX_PROBLEMS,
  type CleanupUploadJob,
  cleanupJobId,
  MAX_PENDING_UPLOADS,
  MEDIA_LABELS,
  type MediaKind,
  mediaKindOf,
  type MediaUrlView,
  type MessageListQuery,
  type MessageMediaView,
  type MessagePage,
  type ReserveUploadInput,
  type MessageView,
  type Permission,
  PROBLEM_TYPES,
  QUEUE_NAMES,
  type RealtimeEvent,
  renderTemplate,
  type SendMessageInput,
  TEMPLATE_PROBLEMS,
  templateBlockedReason,
  templateBody,
  type TemplateView,
  type UploadReservationView,
  type WhatsappOutboundJob,
} from '@nexo/contracts';
import { Prisma, runInTenantTransaction, type TenantTransactionClient } from '@nexo/database';
import {
  assertTenantKey,
  type ObjectStorage,
  resolveMime,
  SNIFF_BYTES,
  sniffMime,
  tenantKey,
} from '@nexo/storage';
import type { Queue } from 'bullmq';
import type { Request } from 'express';
import { ProblemException } from '../common/problem.exception';
import { traceIdOf } from '../common/trace-id';
import { API_ENV } from '../config/config.module';
import { AuditService } from '../queues/audit.service';
import { MAINTENANCE_QUEUE, WHATSAPP_OUTBOUND_QUEUE } from '../queues/queue-tokens';
import { TemplatesService } from '../whatsapp/templates.service';
import { RealtimeService } from '../realtime/realtime.service';
import { OBJECT_STORAGE } from '../storage/storage.module';
import { AccessService, type ResolvedAccess } from '../team/access.service';
import { conflict, notFound } from '../team/team.problems';

const summarySelect = {
  id: true,
  status: true,
  assigneeId: true,
  lastMessageAt: true,
  lastMessagePreview: true,
  lastMessageDirection: true,
  unreadCount: true,
  windowExpiresAt: true,
  contact: { select: { id: true, fullName: true, whatsappE164: true, phoneE164: true } },
  channel: { select: { id: true, name: true, displayId: true, status: true } },
  assignee: { select: { id: true, name: true } },
} satisfies Prisma.ConversationSelect;

type SummaryRow = Prisma.ConversationGetPayload<{ select: typeof summarySelect }>;

const OPEN_STATES = ['OPEN', 'PENDING', 'SNOOZED'] as const;

/**
 * Bandeja de entrada.
 *
 * QUÉ conversaciones ve cada uno: las SIN asignar, todo el que puede ver
 * conversaciones (para poder tomarlas); las asignadas, según el alcance de su
 * permiso sobre la persona asignada. El mismo criterio decide quién recibe los
 * avisos en tiempo real (RealtimeService.canSee).
 *
 * Enviar un mensaje lo guarda como QUEUED y lo encola: la petición no espera
 * a Meta. El worker lo envía y actualiza su estado.
 */
@Injectable()
export class InboxService {
  private readonly logger = new Logger('Bandeja');

  constructor(
    private readonly accessService: AccessService,
    private readonly audit: AuditService,
    private readonly realtime: RealtimeService,
    @Inject(WHATSAPP_OUTBOUND_QUEUE) private readonly outbound: Queue,
    @Inject(MAINTENANCE_QUEUE) private readonly maintenance: Queue,
    @Inject(API_ENV) private readonly env: ApiEnv,
    private readonly templates: TemplatesService,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage | null,
  ) {}

  /* ======================================================================== */
  /*  Lectura                                                                  */
  /* ======================================================================== */

  async list(access: ResolvedAccess, query: ConversationListQuery): Promise<ConversationList> {
    const visible = await this.visibleWhere(access, 'conversation:read');
    const state: Prisma.ConversationWhereInput =
      query.state === 'resolved' ? { status: 'RESOLVED' } : { status: { in: [...OPEN_STATES] } };
    const views: Record<keyof ConversationCounts, Prisma.ConversationWhereInput> = {
      mine: { assigneeId: access.userId },
      unassigned: { assigneeId: null },
      all: {},
    };
    const search: Prisma.ConversationWhereInput = query.q
      ? {
          contact: {
            OR: [
              { fullName: { contains: query.q, mode: 'insensitive' } },
              { whatsappE164: { contains: query.q.replace(/[^\d+]/g, '') || query.q } },
            ],
          },
        }
      : {};

    return runInTenantTransaction(async (tx) => {
      const rows = await tx.conversation.findMany({
        where: { AND: [visible, state, views[query.view], search] },
        select: summarySelect,
        orderBy: [{ lastMessageAt: { sort: 'desc', nulls: 'last' } }, { id: 'desc' }],
        take: query.limit + 1,
        ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      });

      const [mine, unassigned, all] = await Promise.all(
        (['mine', 'unassigned', 'all'] as const).map((view) =>
          tx.conversation.count({
            where: {
              AND: [visible, { status: { in: [...OPEN_STATES] } }, views[view]],
              unreadCount: { gt: 0 },
            },
          }),
        ),
      );

      const hasMore = rows.length > query.limit;
      const data = (hasMore ? rows.slice(0, query.limit) : rows).map(toSummary);
      return {
        data,
        hasMore,
        nextCursor: hasMore ? (data[data.length - 1]?.id ?? null) : null,
        unread: { mine: mine!, unassigned: unassigned!, all: all! },
      };
    });
  }

  async get(access: ResolvedAccess, id: string): Promise<ConversationDetail> {
    const visible = await this.visibleWhere(access, 'conversation:read');
    const row = await runInTenantTransaction((tx) =>
      tx.conversation.findFirst({ where: { AND: [{ id }, visible] }, select: summarySelect }),
    );
    if (!row) throw notFound('Conversación');
    return this.detail(access, row);
  }

  async messages(
    access: ResolvedAccess,
    id: string,
    query: MessageListQuery,
  ): Promise<MessagePage> {
    const visible = await this.visibleWhere(access, 'conversation:read');
    return runInTenantTransaction(async (tx) => {
      const conversation = await tx.conversation.findFirst({
        where: { AND: [{ id }, visible] },
        select: { id: true },
      });
      if (!conversation) throw notFound('Conversación');

      const rows = await tx.message.findMany({
        where: { conversationId: id, isInternal: false },
        select: {
          id: true,
          direction: true,
          type: true,
          body: true,
          status: true,
          errorMessage: true,
          senderUserId: true,
          createdAt: true,
          media: {
            select: {
              id: true,
              fileId: true,
              mimeType: true,
              filename: true,
              sizeBytes: true,
              downloadError: true,
              file: { select: { originalName: true, mimeType: true, sizeBytes: true } },
            },
            orderBy: { createdAt: 'asc' },
            take: 1,
          },
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: query.limit + 1,
        ...(query.before ? { cursor: { id: query.before }, skip: 1 } : {}),
      });
      const hasMore = rows.length > query.limit;
      const page = (hasMore ? rows.slice(0, query.limit) : rows).reverse();

      const senderIds = [...new Set(page.map((m) => m.senderUserId).filter((v) => v !== null))];
      const senders = senderIds.length
        ? await tx.user.findMany({
            where: { id: { in: senderIds } },
            select: { id: true, name: true },
          })
        : [];
      const byId = new Map(senders.map((u) => [u.id, u]));

      const data: MessageView[] = page.map((m) => ({
        id: m.id,
        direction: m.direction,
        type: m.type,
        body: m.body,
        status: m.status,
        errorMessage: m.errorMessage,
        sender: m.senderUserId ? (byId.get(m.senderUserId) ?? null) : null,
        media: m.media[0] ? toMediaView(m.media[0]) : null,
        createdAt: m.createdAt.toISOString(),
      }));
      return { data, hasMore };
    });
  }

  /**
   * URL firmada para ver o descargar un archivo, válida unos minutos.
   *
   * Los bytes NO pasan por la API: el navegador los pide al almacenamiento.
   * Por eso todo lo que decide cómo se sirve —tipo, mostrar o descargar,
   * nombre— se firma aquí: un cliente no puede pedir que un PDF se abra en el
   * navegador, ni cambiar la clave, sin romper la firma.
   *
   * Sin auditoría: son vistas normales de la bandeja, y una conversación con
   * veinte fotos generaría veinte entradas cada vez que alguien la abre. Las
   * acciones sensibles (exportaciones, documentos comerciales) sí se auditan.
   */
  async mediaUrl(
    access: ResolvedAccess,
    conversationId: string,
    mediaId: string,
  ): Promise<MediaUrlView> {
    if (!this.storage) {
      throw new ProblemException({
        type: PROBLEM_TYPES.UNAVAILABLE,
        title: 'Los archivos no están disponibles',
        status: HttpStatus.SERVICE_UNAVAILABLE,
        detail: 'El almacenamiento no está configurado en este entorno.',
      });
    }
    // Mismo filtro que la bandeja: quien no ve la conversación no ve sus
    // archivos, y recibe 404 (no 403): tampoco se le confirma que existan.
    const visible = await this.visibleWhere(access, 'conversation:read');

    const media = await runInTenantTransaction(async (tx) => {
      const conversation = await tx.conversation.findFirst({
        where: { AND: [{ id: conversationId }, visible] },
        select: { id: true },
      });
      if (!conversation) throw notFound('Conversación');
      return tx.messageMedia.findFirst({
        // Tiene que ser de ESA conversación: el id de otra no sirve.
        where: { id: mediaId, message: { conversationId } },
        select: {
          id: true,
          tenantId: true,
          downloadError: true,
          filename: true,
          file: {
            select: {
              storageKey: true,
              bucket: true,
              mimeType: true,
              originalName: true,
              status: true,
              deletedAt: true,
              tenantId: true,
            },
          },
        },
      });
    });
    if (!media) throw notFound('Archivo');

    const file = media.file;
    if (!file || file.status !== 'READY' || file.deletedAt) {
      throw new ProblemException({
        type: INBOX_PROBLEMS.MEDIA_NOT_READY,
        title: 'El archivo no está disponible',
        status: HttpStatus.CONFLICT,
        detail:
          media.downloadError ?? 'Todavía se está guardando. Vuelve a intentarlo en unos segundos.',
      });
    }
    // Última red, tras RLS y la clave foránea compuesta: la clave es de esta
    // empresa o no se firma nada.
    if (file.tenantId !== access.tenantId) throw notFound('Archivo');
    assertTenantKey(access.tenantId, file.storageKey);
    // El archivo guarda SU bucket. Si la configuración apunta a otro, firmar
    // esta clave daría una URL que no sirve: mejor decirlo que devolver un
    // 404 del almacenamiento que nadie sabría interpretar.
    if (file.bucket !== this.storage.bucket) {
      throw new ProblemException({
        type: INBOX_PROBLEMS.MEDIA_NOT_READY,
        title: 'El archivo no está disponible',
        status: HttpStatus.CONFLICT,
        detail: 'Está guardado en otro almacenamiento. Avisa a soporte.',
      });
    }

    const expiresInSeconds = this.storage.urlTtlSeconds;
    const filename = media.filename ?? file.originalName;
    const disposition = dispositionFor(file.mimeType);
    const url = await this.storage.signedGetUrl(file.storageKey, {
      expiresInSeconds,
      contentType: file.mimeType,
      disposition,
      filename,
    });
    return {
      url,
      expiresAt: new Date(Date.now() + expiresInSeconds * 1000).toISOString(),
      filename,
      mimeType: file.mimeType,
      disposition,
    };
  }

  /* ======================================================================== */
  /*  Escritura                                                                */
  /* ======================================================================== */

  /** Plantillas que se pueden enviar HOY en esta conversación. */
  async templatesFor(access: ResolvedAccess, conversationId: string): Promise<TemplateView[]> {
    const writable = await this.visibleWhere(access, 'conversation:write');
    const conversation = await runInTenantTransaction((tx) =>
      tx.conversation.findFirst({
        where: { AND: [{ id: conversationId }, writable] },
        select: { channelId: true },
      }),
    );
    if (!conversation) throw notFound('Conversación');
    return this.templates.sendable(conversation.channelId);
  }

  /**
   * Reserva una subida: comprueba lo que se puede comprobar ANTES de que
   * existan los bytes (permiso, canal, ventana, tipo y tamaño declarados) y
   * devuelve una URL firmada para que el navegador suba el archivo DIRECTO al
   * almacenamiento. La API no mueve bytes.
   *
   * Lo declarado sólo sirve para firmar: el tipo y el tamaño van dentro de la
   * firma —subir otra cosa lo rechaza el almacenamiento— y, además, al enviar
   * el mensaje se comprueba el objeto de verdad.
   */
  async reserveUpload(
    access: ResolvedAccess,
    conversationId: string,
    input: ReserveUploadInput,
  ): Promise<UploadReservationView> {
    const storage = this.requireStorage();
    const writable = await this.visibleWhere(access, 'conversation:write');

    const kind = mediaKindOf(input.mimeType);
    const check = checkMedia({ mime: input.mimeType, sizeBytes: input.sizeBytes });
    if (!check.ok || !kind || !canSend(kind)) {
      throw new ProblemException({
        type: PROBLEM_TYPES.VALIDATION,
        title: 'No se puede enviar ese archivo',
        status: HttpStatus.BAD_REQUEST,
        errors: [
          {
            field: 'file',
            message: check.ok ? 'WhatsApp no permite enviar este tipo de archivo' : check.reason,
          },
        ],
      });
    }

    const key = tenantKey(access.tenantId, 'whatsapp-media', check.extension);
    assertTenantKey(access.tenantId, key);

    const fileId = await runInTenantTransaction(async (tx) => {
      const conversation = await tx.conversation.findFirst({
        where: { AND: [{ id: conversationId }, writable] },
        select: {
          id: true,
          windowExpiresAt: true,
          channel: { select: { status: true, credentialsEncrypted: true } },
        },
      });
      if (!conversation) throw notFound('Conversación');
      assertCanSend(conversation, new Date());

      // Cada reserva es una fila y un permiso de escritura: no se acumulan.
      const pending = await tx.file.count({
        where: { uploadedById: access.userId, status: 'PENDING', deletedAt: null },
      });
      if (pending >= MAX_PENDING_UPLOADS) {
        throw new ProblemException({
          type: INBOX_PROBLEMS.UPLOAD_LIMIT,
          title: 'Tienes demasiadas subidas sin terminar',
          status: HttpStatus.TOO_MANY_REQUESTS,
          detail: `Puedes tener ${MAX_PENDING_UPLOADS} archivos subiéndose a la vez. Termina o cancela los anteriores e inténtalo de nuevo.`,
        });
      }

      const file = await tx.file.create({
        data: {
          tenantId: access.tenantId,
          storageKey: key,
          bucket: storage.bucket,
          originalName: input.filename,
          mimeType: input.mimeType,
          sizeBytes: input.sizeBytes,
          purpose: 'WHATSAPP_MEDIA',
          status: 'PENDING',
          uploadedById: access.userId,
          scanStatus: 'SKIPPED',
          scanResult: 'sin antivirus configurado',
        },
        select: { id: true },
      });
      return file.id;
    });

    // Trabajo APLAZADO: si el archivo sigue sin enviarse pasado el plazo, se
    // borran objeto y fila. Si se envía, al saltar no encuentra nada que
    // borrar. Que falle encolarlo no debe impedir la subida: sólo dejaría una
    // reserva que nadie recoge, y se avisa en el registro.
    const job: CleanupUploadJob = { fileId, tenantId: access.tenantId };
    await this.maintenance
      .add(QUEUE_NAMES.MAINTENANCE, job, {
        jobId: cleanupJobId(fileId),
        delay: this.env.STORAGE_PENDING_TTL_HOURS * 3600_000,
      })
      .catch((error: Error) =>
        this.logger.error(
          `No se pudo programar la limpieza del archivo ${fileId}: ${error.message}`,
        ),
      );

    const expiresInSeconds = storage.urlTtlSeconds;
    const url = await storage.signedPutUrl(key, {
      expiresInSeconds,
      contentType: input.mimeType,
      contentLength: input.sizeBytes,
    });
    return {
      fileId,
      url,
      expiresAt: new Date(Date.now() + expiresInSeconds * 1000).toISOString(),
      // El PUT tiene que enviarlas EXACTAS: van dentro de la firma.
      headers: { 'Content-Type': input.mimeType },
    };
  }

  /**
   * Responde por WhatsApp. Responder a una conversación sin asignar la toma:
   * quien contesta es quien la lleva, y así dos agentes no contestan a la vez
   * al mismo cliente sin saberlo.
   */
  async send(access: ResolvedAccess, id: string, input: SendMessageInput): Promise<MessageView> {
    const writable = await this.visibleWhere(access, 'conversation:write');
    const now = new Date();
    const body = input.body?.trim() ? input.body.trim() : null;

    // El archivo se comprueba ANTES de la transacción: son llamadas al
    // almacenamiento, y no deben tener abierta una transacción esperando.
    const attachment = input.fileId ? await this.verifyUpload(access, input.fileId, body) : null;

    const { message, event, sender, rendered } = await runInTenantTransaction(async (tx) => {
      // Bloquea la fila: dos envíos simultáneos a una conversación sin asignar
      // no la asignan a dos personas.
      await tx.$queryRaw`SELECT id FROM conversation WHERE id = ${id}::uuid FOR UPDATE`;
      const conversation = await tx.conversation.findFirst({
        where: { AND: [{ id }, writable] },
        select: {
          id: true,
          channelId: true,
          assigneeId: true,
          windowExpiresAt: true,
          channel: { select: { status: true, credentialsEncrypted: true } },
        },
      });
      if (!conversation) throw notFound('Conversación');
      // Una plantilla es lo ÚNICO que Meta deja enviar fuera de la ventana:
      // para ella sólo se exige que el canal siga conectado.
      assertCanSend(conversation, now, { requireWindow: !input.templateId });

      const template = input.templateId
        ? await loadTemplate(tx, conversation.channelId, input.templateId, input.variables ?? [])
        : null;

      if (attachment) {
        // Sólo un mensaje puede llevarse este archivo: si otro envío se
        // adelantó, ya no está PENDING y esto afecta a 0 filas.
        const claimed = await tx.file.updateMany({
          where: { id: attachment.fileId, status: 'PENDING' },
          data: {
            status: 'READY',
            readyAt: now,
            mimeType: attachment.mimeType,
            sizeBytes: attachment.sizeBytes,
          },
        });
        if (claimed.count === 0) {
          throw conflict(
            'Ese archivo ya se envió',
            'Adjúntalo otra vez si quieres volver a enviarlo.',
            INBOX_PROBLEMS.UPLOAD_USED,
          );
        }
      }

      const created = await tx.message.create({
        data: {
          tenantId: access.tenantId,
          conversationId: id,
          channelId: conversation.channelId,
          direction: 'OUTBOUND',
          type: template ? 'TEMPLATE' : attachment ? attachment.messageType : 'TEXT',
          // El texto que se guarda es el de la plantilla YA rellenado: es lo
          // que verá el cliente y lo que tiene que ver el equipo.
          body: template ? template.rendered : body,
          ...(template
            ? { templateId: template.id, templateParams: { variables: input.variables ?? [] } }
            : {}),
          status: 'QUEUED',
          statusUpdatedAt: now,
          senderUserId: access.userId,
          senderType: 'USER',
          createdAt: now,
        },
        select: { id: true, createdAt: true },
      });

      if (attachment) {
        await tx.messageMedia.create({
          data: {
            tenantId: access.tenantId,
            messageId: created.id,
            fileId: attachment.fileId,
            mimeType: attachment.mimeType,
            filename: attachment.filename,
            sizeBytes: attachment.sizeBytes,
            caption: body,
            downloadedAt: now,
          },
        });
      }

      const takes = conversation.assigneeId === null;
      await tx.conversation.update({
        where: { id },
        data: {
          lastMessageAt: now,
          lastMessagePreview: preview(
            attachment?.kind ?? null,
            template ? template.rendered : body,
          ),
          lastMessageDirection: 'OUTBOUND',
          // Quien responde ya leyó lo anterior.
          unreadCount: 0,
          status: 'OPEN',
          resolvedAt: null,
          ...(takes ? { assigneeId: access.userId } : {}),
        },
      });

      const event: RealtimeEvent = {
        type: 'conversation',
        conversationId: id,
        assigneeId: takes ? access.userId : conversation.assigneeId,
        ...(takes ? { previousAssigneeId: null } : {}),
        reason: 'message',
      };
      const sender = await tx.user.findUnique({
        where: { id: access.userId },
        select: { id: true, name: true },
      });
      return { message: created, event, sender, rendered: template?.rendered ?? body };
    });

    await this.enqueue(access.tenantId, message.id, message.id);
    await this.realtime.publish(access.tenantId, event);

    return {
      id: message.id,
      direction: 'OUTBOUND',
      type: input.templateId ? 'TEMPLATE' : attachment ? attachment.messageType : 'TEXT',
      body: rendered,
      status: 'QUEUED',
      errorMessage: null,
      sender,
      media: attachment
        ? {
            id: attachment.fileId,
            status: 'ready',
            mimeType: attachment.mimeType,
            filename: attachment.filename,
            sizeBytes: attachment.sizeBytes,
            error: null,
          }
        : null,
      createdAt: message.createdAt.toISOString(),
    };
  }

  /**
   * Comprueba el objeto que el navegador subió: que exista, su tamaño real y
   * su tipo REAL por número mágico. Lo declarado al reservar no decide nada.
   *
   * Si no cuadra, el archivo queda REJECTED y el objeto se borra: no se envía
   * a un cliente algo que no es lo que dijo ser, y no queda basura.
   */
  private async verifyUpload(
    access: ResolvedAccess,
    fileId: string,
    body: string | null,
  ): Promise<{
    fileId: string;
    kind: MediaKind;
    messageType: 'IMAGE' | 'AUDIO' | 'VIDEO' | 'DOCUMENT' | 'STICKER';
    mimeType: string;
    filename: string;
    sizeBytes: number;
  }> {
    const storage = this.requireStorage();
    const file = await runInTenantTransaction((tx) =>
      tx.file.findFirst({
        // Sólo quien reservó la subida puede adjuntarla: `file` no cuelga de
        // ninguna conversación, y el destino ya exige permiso de escritura.
        where: { id: fileId, deletedAt: null, uploadedById: access.userId },
        select: {
          id: true,
          status: true,
          storageKey: true,
          originalName: true,
          mimeType: true,
          rejectReason: true,
          tenantId: true,
        },
      }),
    );
    if (!file || file.tenantId !== access.tenantId) throw notFound('Archivo');
    if (file.status === 'READY') {
      throw conflict(
        'Ese archivo ya se envió',
        'Adjúntalo otra vez si quieres volver a enviarlo.',
        INBOX_PROBLEMS.UPLOAD_USED,
      );
    }
    if (file.status !== 'PENDING') {
      throw new ProblemException({
        type: INBOX_PROBLEMS.UPLOAD_INVALID,
        title: 'El archivo no se puede enviar',
        status: HttpStatus.BAD_REQUEST,
        detail: file.rejectReason ?? 'Se descartó al comprobarlo. Vuelve a adjuntarlo.',
      });
    }
    assertTenantKey(access.tenantId, file.storageKey);

    const reject = async (detail: string): Promise<never> => {
      await runInTenantTransaction((tx) =>
        tx.file.updateMany({
          where: { id: file.id, status: 'PENDING' },
          data: { status: 'REJECTED', rejectReason: detail.slice(0, 300) },
        }),
      );
      await storage.delete([file.storageKey]).catch((error: Error) => {
        this.logger.error(`No se pudo borrar un archivo rechazado: ${error.message}`);
      });
      throw new ProblemException({
        type: INBOX_PROBLEMS.UPLOAD_INVALID,
        title: 'El archivo no se puede enviar',
        status: HttpStatus.BAD_REQUEST,
        detail,
      });
    };

    const info = await storage.head(file.storageKey);
    if (!info) {
      throw new ProblemException({
        type: INBOX_PROBLEMS.UPLOAD_INVALID,
        title: 'El archivo no llegó a subirse',
        status: HttpStatus.BAD_REQUEST,
        detail: 'Vuelve a adjuntarlo: la subida no se completó.',
      });
    }

    const head = await storage.getRange(file.storageKey, SNIFF_BYTES);
    const real = resolveMime(info.contentType, sniffMime(head));
    const check = real ? checkMedia({ mime: real, sizeBytes: info.sizeBytes }) : null;
    if (!real || !check?.ok || !canSend(check.kind)) {
      return reject(
        check && !check.ok
          ? check.reason
          : 'El contenido del archivo no es de un tipo que WhatsApp permita enviar',
      );
    }
    // Y tiene que ser de la MISMA categoría que se declaró al reservar: un
    // HTML subido como «imagen» es texto, un tipo admitido, pero no una
    // imagen. Misma regla que para lo que llega de Meta (paso 4).
    if (mediaKindOf(file.mimeType) !== check.kind) {
      return reject(`El contenido no es del tipo declarado (${file.mimeType})`);
    }
    // El archivo es válido: no se rechaza ni se borra, porque se puede
    // reenviar sin texto.
    if (body && !allowsCaption(check.kind)) {
      throw new ProblemException({
        type: PROBLEM_TYPES.VALIDATION,
        title: 'Ese tipo de archivo no admite texto',
        status: HttpStatus.BAD_REQUEST,
        errors: [
          {
            field: 'body',
            message: `WhatsApp no muestra texto junto a un ${MEDIA_LABELS[check.kind].toLowerCase()}: envíalo aparte`,
          },
        ],
      });
    }

    return {
      fileId: file.id,
      kind: check.kind,
      messageType: check.messageType,
      mimeType: real,
      filename: file.originalName,
      sizeBytes: info.sizeBytes,
    };
  }

  private requireStorage(): ObjectStorage {
    if (!this.storage) {
      throw new ProblemException({
        type: PROBLEM_TYPES.UNAVAILABLE,
        title: 'Los archivos no están disponibles',
        status: HttpStatus.SERVICE_UNAVAILABLE,
        detail: 'El almacenamiento no está configurado en este entorno.',
      });
    }
    return this.storage;
  }

  /** Vuelve a intentar un mensaje que falló. Sigue exigiendo la ventana abierta. */
  async retry(access: ResolvedAccess, id: string, messageId: string): Promise<void> {
    const writable = await this.visibleWhere(access, 'conversation:write');
    const event = await runInTenantTransaction(async (tx) => {
      const conversation = await tx.conversation.findFirst({
        where: { AND: [{ id }, writable] },
        select: {
          id: true,
          assigneeId: true,
          windowExpiresAt: true,
          channel: { select: { status: true, credentialsEncrypted: true } },
        },
      });
      if (!conversation) throw notFound('Conversación');
      assertCanSend(conversation, new Date());

      const updated = await tx.message.updateMany({
        where: { id: messageId, conversationId: id, direction: 'OUTBOUND', status: 'FAILED' },
        data: {
          status: 'QUEUED',
          statusUpdatedAt: new Date(),
          errorCode: null,
          errorMessage: null,
        },
      });
      if (updated.count === 0) {
        throw conflict('Este mensaje no se puede reintentar', 'Sólo se reintentan los fallidos.');
      }
      return {
        type: 'conversation',
        conversationId: id,
        assigneeId: conversation.assigneeId,
        reason: 'delivery',
      } satisfies RealtimeEvent;
    });

    // Id de trabajo nuevo: el del intento anterior puede seguir en la lista de
    // fallidos, y BullMQ ignoraría un trabajo con el mismo id.
    await this.enqueue(access.tenantId, messageId, `${messageId}-r${Date.now()}`);
    await this.realtime.publish(access.tenantId, event);
  }

  async markRead(access: ResolvedAccess, id: string): Promise<void> {
    const visible = await this.visibleWhere(access, 'conversation:read');
    const changed = await runInTenantTransaction(async (tx) => {
      const conversation = await tx.conversation.findFirst({
        where: { AND: [{ id }, visible] },
        select: { id: true, assigneeId: true, unreadCount: true },
      });
      if (!conversation) throw notFound('Conversación');
      if (conversation.unreadCount === 0) return null;
      await tx.conversation.update({ where: { id }, data: { unreadCount: 0 } });
      return { assigneeId: conversation.assigneeId };
    });
    // Sólo se avisa si de verdad había algo sin leer.
    if (changed) await this.publish(access.tenantId, id, changed.assigneeId, 'read');
  }

  async setStatus(
    access: ResolvedAccess,
    id: string,
    status: 'OPEN' | 'RESOLVED',
    req: Request,
  ): Promise<ConversationDetail> {
    const writable = await this.visibleWhere(access, 'conversation:write');
    const row = await runInTenantTransaction(async (tx) => {
      const conversation = await tx.conversation.findFirst({
        where: { AND: [{ id }, writable] },
        select: { id: true, status: true },
      });
      if (!conversation) throw notFound('Conversación');
      if (conversation.status !== status) {
        await tx.conversation.update({
          where: { id },
          data: {
            status,
            resolvedAt: status === 'RESOLVED' ? new Date() : null,
            snoozedUntil: null,
          },
        });
      }
      return tx.conversation.findUniqueOrThrow({ where: { id }, select: summarySelect });
    });

    await this.record(access, req, id, row.contact.fullName, { status });
    await this.publish(access.tenantId, id, row.assigneeId, 'status');
    return this.detail(access, row);
  }

  /**
   * Asignar, tomar o liberar.
   *
   *  · Tomar una SIN asignar: basta con poder responder (conversation:write).
   *    La condición `assigneeId IS NULL` va en el propio UPDATE: si dos la
   *    toman a la vez, sólo uno lo consigue y el otro recibe 409.
   *  · Liberar la propia: también con conversation:write.
   *  · Cualquier otra cosa (asignar a otro, quitársela a alguien): exige
   *    conversation:assign, y dentro de su alcance, tanto sobre quien la tenía
   *    como sobre quien la recibe.
   */
  async assign(
    access: ResolvedAccess,
    id: string,
    userId: string | null,
    req: Request,
  ): Promise<ConversationDetail> {
    const canAssign = Boolean(access.permissions['conversation:assign']);
    const readable = await this.visibleWhere(access, 'conversation:read');
    const assignScope = canAssign
      ? await this.accessService.rowFilter(access, 'conversation:assign', 'assigneeId')
      : null;

    const { row, previous } = await runInTenantTransaction(async (tx) => {
      const conversation = await tx.conversation.findFirst({
        where: { AND: [{ id }, readable] },
        select: { id: true, assigneeId: true },
      });
      if (!conversation) throw notFound('Conversación');
      const previous = conversation.assigneeId;
      if (previous === userId) {
        return {
          row: await tx.conversation.findUniqueOrThrow({ where: { id }, select: summarySelect }),
          previous,
        };
      }

      const taking = userId === access.userId && previous === null;
      const releasingOwn = userId === null && previous === access.userId;

      if (taking || releasingOwn) {
        if (!access.permissions['conversation:write']) throw forbidden('responder conversaciones');
        const done = await tx.conversation.updateMany({
          where: { id, assigneeId: previous },
          data: { assigneeId: userId },
        });
        if (done.count === 0) throw alreadyAssigned();
      } else {
        if (!canAssign) {
          if (previous !== null && userId === access.userId) throw alreadyAssigned();
          throw forbidden('asignar conversaciones');
        }
        // Quien la tenía tiene que estar en su alcance (no se la quita a
        // alguien de otro equipo)…
        if (previous !== null && assignScope) {
          const inScope = await tx.conversation.count({
            where: { AND: [{ id }, assignScope as Prisma.ConversationWhereInput] },
          });
          if (inScope === 0) throw forbidden('reasignar conversaciones de otros equipos');
        }
        // …y quien la recibe, también, y tiene que poder verla.
        if (userId !== null) await this.assertAssignable(tx, access, userId);

        const done = await tx.conversation.updateMany({
          where: { id, assigneeId: previous },
          data: { assigneeId: userId },
        });
        if (done.count === 0) throw alreadyAssigned();
      }

      return {
        row: await tx.conversation.findUniqueOrThrow({ where: { id }, select: summarySelect }),
        previous,
      };
    });

    if (previous !== row.assigneeId) {
      await this.record(access, req, id, row.contact.fullName, {
        assigneeId: { from: previous, to: row.assigneeId },
      });
      await this.realtime.publish(access.tenantId, {
        type: 'conversation',
        conversationId: id,
        assigneeId: row.assigneeId,
        previousAssigneeId: previous,
        reason: 'assignment',
      });
    }
    return this.detail(access, row);
  }

  /* ======================================================================== */

  /**
   * Filtro de visibilidad: el alcance del permiso sobre la persona asignada,
   * más las conversaciones sin asignar.
   */
  private async visibleWhere(
    access: ResolvedAccess,
    permission: Permission,
  ): Promise<Prisma.ConversationWhereInput> {
    const scope = await this.accessService.rowFilter(access, permission, 'assigneeId');
    if (!scope) return {};
    return { OR: [scope, { assigneeId: null }] };
  }

  private async assertAssignable(
    tx: TenantTransactionClient,
    access: ResolvedAccess,
    userId: string,
  ): Promise<void> {
    const membership = await tx.membership.findFirst({
      where: { userId, status: 'ACTIVE' },
      select: { id: true },
    });
    const target = membership
      ? await this.accessService.resolve(access.tenantId, membership.id)
      : null;
    if (!target || !target.permissions['conversation:read']) {
      throw new ProblemException({
        type: PROBLEM_TYPES.VALIDATION,
        title: 'No se le puede asignar',
        status: HttpStatus.BAD_REQUEST,
        errors: [
          { field: 'userId', message: 'no es un miembro activo que pueda ver conversaciones' },
        ],
      });
    }
    const scope = access.permissions['conversation:assign'];
    if (scope === 'OWN' && userId !== access.userId) {
      throw forbidden('asignar conversaciones a otras personas');
    }
    if (scope === 'TEAM' && !(await this.accessService.teamUserIds(access)).includes(userId)) {
      throw forbidden('asignar conversaciones fuera de tu equipo');
    }
  }

  private async detail(access: ResolvedAccess, row: SummaryRow): Promise<ConversationDetail> {
    const writable = await this.inScope(access, 'conversation:write', row.assigneeId);
    const assignable = await this.inScope(access, 'conversation:assign', row.assigneeId);
    return {
      ...toSummary(row),
      channelConnected: row.channel.status === 'CONNECTED',
      can: {
        reply: writable,
        take: row.assigneeId === null && Boolean(access.permissions['conversation:write']),
        assign: assignable,
      },
    };
  }

  /** ¿La conversación (por su asignación) entra en el alcance de ese permiso? */
  private async inScope(
    access: ResolvedAccess,
    permission: Permission,
    assigneeId: string | null,
  ): Promise<boolean> {
    const scope = access.permissions[permission];
    if (!scope) return false;
    if (scope === 'ALL' || assigneeId === null || assigneeId === access.userId) return true;
    if (scope === 'TEAM')
      return (await this.accessService.teamUserIds(access)).includes(assigneeId);
    return false;
  }

  private async enqueue(tenantId: string, messageId: string, jobId: string): Promise<void> {
    const job: WhatsappOutboundJob = { messageId, tenantId };
    try {
      await this.outbound.add(QUEUE_NAMES.WHATSAPP_OUTBOUND, job, { jobId });
    } catch (error) {
      // Sin cola no hay envío: el mensaje no puede quedarse «en cola» para
      // siempre. Se marca fallido y el agente lo puede reintentar.
      this.logger.error(`No se pudo encolar el mensaje ${messageId}: ${(error as Error).message}`);
      await runInTenantTransaction((tx) =>
        tx.message.update({
          where: { id: messageId },
          data: {
            status: 'FAILED',
            errorMessage: 'No se pudo poner en cola. Inténtalo de nuevo.',
          },
        }),
      );
      throw new ProblemException({
        type: PROBLEM_TYPES.UNAVAILABLE,
        title: 'No se pudo enviar ahora',
        status: HttpStatus.SERVICE_UNAVAILABLE,
        detail: 'El mensaje quedó marcado como fallido; puedes reintentarlo en unos segundos.',
      });
    }
  }

  private publish(
    tenantId: string,
    conversationId: string,
    assigneeId: string | null,
    reason: RealtimeEvent['reason'],
  ): Promise<void> {
    return this.realtime.publish(tenantId, {
      type: 'conversation',
      conversationId,
      assigneeId,
      reason,
    });
  }

  private record(
    access: ResolvedAccess,
    req: Request,
    id: string,
    label: string,
    changes: Record<string, unknown>,
  ): Promise<void> {
    return this.audit.record({
      tenantId: access.tenantId,
      actorUserId: access.userId,
      action: 'UPDATE',
      resourceType: 'Conversation',
      resourceId: id,
      resourceLabel: label,
      changes,
      ip: req.ip,
      userAgent: req.headers['user-agent']?.slice(0, 500),
      traceId: traceIdOf(req),
    });
  }
}

/* ========================================================================== */

function toSummary(row: SummaryRow): ConversationSummary {
  return {
    id: row.id,
    status: row.status,
    contact: {
      id: row.contact.id,
      name: row.contact.fullName || row.contact.whatsappE164 || 'Sin nombre',
      phone: row.contact.whatsappE164 ?? row.contact.phoneE164,
    },
    channel: { id: row.channel.id, name: row.channel.name, displayId: row.channel.displayId },
    assignee: row.assignee,
    lastMessageAt: row.lastMessageAt?.toISOString() ?? null,
    lastMessagePreview: row.lastMessagePreview,
    lastMessageDirection: row.lastMessageDirection,
    unreadCount: row.unreadCount,
    windowExpiresAt: row.windowExpiresAt?.toISOString() ?? null,
  };
}

/**
 * La plantilla, comprobando que es de ESTE canal, que Meta la aprobó, que
 * Nexo sabe enviarla y que las variables cuadran exactamente.
 */
async function loadTemplate(
  tx: TenantTransactionClient,
  channelId: string,
  templateId: string,
  variables: string[],
): Promise<{ id: string; rendered: string }> {
  const template = await tx.waTemplate.findFirst({
    // De este canal: la de otro número no vale, aunque sea de la misma empresa.
    where: { id: templateId, channelId },
    select: { id: true, status: true, components: true },
  });
  if (!template) throw notFound('Plantilla');

  const blocked =
    template.status !== 'APPROVED'
      ? `Meta la tiene en estado ${template.status.toLowerCase()}`
      : templateBlockedReason(template.components);
  if (blocked) {
    throw new ProblemException({
      type: TEMPLATE_PROBLEMS.NOT_SENDABLE,
      title: 'Esa plantilla no se puede enviar',
      status: HttpStatus.CONFLICT,
      detail: blocked,
    });
  }

  const body = templateBody(template.components);
  const expected = countVariables(body);
  if (variables.length !== expected) {
    throw new ProblemException({
      type: PROBLEM_TYPES.VALIDATION,
      title: 'Faltan o sobran variables',
      status: HttpStatus.BAD_REQUEST,
      errors: [
        {
          field: 'variables',
          message: `esta plantilla necesita ${expected} ${expected === 1 ? 'variable' : 'variables'}, y llegaron ${variables.length}`,
        },
      ],
    });
  }
  return { id: template.id, rendered: renderTemplate(body, variables) };
}

/** Vista previa de la bandeja para un mensaje saliente. */
function preview(kind: MediaKind | null, body: string | null): string {
  const label = kind ? MEDIA_LABELS[kind] : null;
  const text = body ?? '';
  const value = label ? (text ? `${label}: ${text}` : label) : text;
  return value.length > 200 ? `${value.slice(0, 197)}…` : value;
}

function toMediaView(media: {
  id: string;
  fileId: string | null;
  mimeType: string | null;
  filename: string | null;
  sizeBytes: number | null;
  downloadError: string | null;
  file: { originalName: string; mimeType: string; sizeBytes: number } | null;
}): MessageMediaView {
  return {
    id: media.id,
    status: media.file ? 'ready' : media.downloadError ? 'failed' : 'pending',
    mimeType: media.file?.mimeType ?? media.mimeType,
    filename: media.filename ?? media.file?.originalName ?? null,
    sizeBytes: media.file?.sizeBytes ?? media.sizeBytes,
    error: media.downloadError,
  };
}

function assertCanSend(
  conversation: {
    windowExpiresAt: Date | null;
    channel: { status: string; credentialsEncrypted: string | null };
  },
  now: Date,
  { requireWindow = true }: { requireWindow?: boolean } = {},
): void {
  if (conversation.channel.status !== 'CONNECTED' || !conversation.channel.credentialsEncrypted) {
    throw conflict(
      'El canal está desconectado',
      'Vuelve a conectar el número en Ajustes → Canales para poder responder.',
      INBOX_PROBLEMS.CHANNEL_DISCONNECTED,
    );
  }
  if (requireWindow && (!conversation.windowExpiresAt || conversation.windowExpiresAt <= now)) {
    throw conflict(
      'Pasaron más de 24 horas desde el último mensaje del cliente',
      'WhatsApp sólo permite responder con texto libre dentro de las 24 horas siguientes al último mensaje del cliente. Fuera de ese plazo hace falta una plantilla aprobada.',
      INBOX_PROBLEMS.WINDOW_CLOSED,
    );
  }
}

const alreadyAssigned = () =>
  conflict(
    'Otra persona ya la tomó',
    'La conversación se asignó mientras tanto. Recarga para ver quién la lleva.',
    INBOX_PROBLEMS.ALREADY_ASSIGNED,
  );

const forbidden = (what: string) =>
  new ProblemException({
    type: PROBLEM_TYPES.FORBIDDEN,
    title: 'No tienes permiso',
    status: HttpStatus.FORBIDDEN,
    detail: `Tu rol no permite ${what}.`,
  });
