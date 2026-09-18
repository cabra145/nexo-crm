import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  assignConversationSchema,
  type ConversationDetail,
  type ConversationList,
  conversationListQuerySchema,
  conversationStatusSchema,
  type MessagePage,
  messageListQuerySchema,
  type MessageView,
  sendMessageSchema,
} from '@nexo/contracts';
import type { Request } from 'express';
import type { z } from 'zod';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { CurrentAccess, RequirePermission } from '../team/access.decorators';
import type { ResolvedAccess } from '../team/access.service';
import { InboxService } from './inbox.service';

const uuid = new ParseUUIDPipe();

/** Bandeja de entrada de WhatsApp. */
@ApiTags('Bandeja')
@ApiBearerAuth()
@Controller('conversations')
export class InboxController {
  constructor(private readonly inbox: InboxService) {}

  @Get()
  @RequirePermission('conversation:read')
  @ApiOperation({ summary: 'Conversaciones: mías, sin asignar o todas, con no leídas por vista' })
  list(
    @CurrentAccess() access: ResolvedAccess,
    @Query(new ZodValidationPipe(conversationListQuerySchema))
    query: z.infer<typeof conversationListQuerySchema>,
  ): Promise<ConversationList> {
    return this.inbox.list(access, query);
  }

  @Get(':id')
  @RequirePermission('conversation:read')
  @ApiOperation({ summary: 'Una conversación, con lo que el usuario puede hacer en ella' })
  get(
    @CurrentAccess() access: ResolvedAccess,
    @Param('id', uuid) id: string,
  ): Promise<ConversationDetail> {
    return this.inbox.get(access, id);
  }

  @Get(':id/messages')
  @RequirePermission('conversation:read')
  @ApiOperation({ summary: 'Mensajes, del más reciente hacia atrás (paginado con `before`)' })
  messages(
    @CurrentAccess() access: ResolvedAccess,
    @Param('id', uuid) id: string,
    @Query(new ZodValidationPipe(messageListQuerySchema))
    query: z.infer<typeof messageListQuerySchema>,
  ): Promise<MessagePage> {
    return this.inbox.messages(access, id, query);
  }

  @Post(':id/messages')
  @RequirePermission('conversation:write')
  @ApiOperation({ summary: 'Responder por WhatsApp (dentro de la ventana de 24 h)' })
  send(
    @CurrentAccess() access: ResolvedAccess,
    @Param('id', uuid) id: string,
    @Body(new ZodValidationPipe(sendMessageSchema)) body: z.infer<typeof sendMessageSchema>,
  ): Promise<MessageView> {
    return this.inbox.send(access, id, body.body);
  }

  @Post(':id/messages/:messageId/retry')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('conversation:write')
  @ApiOperation({ summary: 'Reintentar un mensaje que falló' })
  retry(
    @CurrentAccess() access: ResolvedAccess,
    @Param('id', uuid) id: string,
    @Param('messageId', uuid) messageId: string,
  ): Promise<void> {
    return this.inbox.retry(access, id, messageId);
  }

  @Post(':id/read')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('conversation:read')
  @ApiOperation({ summary: 'Marcar como leída' })
  read(@CurrentAccess() access: ResolvedAccess, @Param('id', uuid) id: string): Promise<void> {
    return this.inbox.markRead(access, id);
  }

  @Post(':id/assign')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('conversation:read')
  @ApiOperation({ summary: 'Tomar, liberar o asignar a otra persona' })
  assign(
    @CurrentAccess() access: ResolvedAccess,
    @Param('id', uuid) id: string,
    @Body(new ZodValidationPipe(assignConversationSchema))
    body: z.infer<typeof assignConversationSchema>,
    @Req() req: Request,
  ): Promise<ConversationDetail> {
    return this.inbox.assign(access, id, body.userId, req);
  }

  @Post(':id/status')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('conversation:write')
  @ApiOperation({ summary: 'Resolver o reabrir' })
  status(
    @CurrentAccess() access: ResolvedAccess,
    @Param('id', uuid) id: string,
    @Body(new ZodValidationPipe(conversationStatusSchema))
    body: z.infer<typeof conversationStatusSchema>,
    @Req() req: Request,
  ): Promise<ConversationDetail> {
    return this.inbox.setStatus(access, id, body.status, req);
  }
}
