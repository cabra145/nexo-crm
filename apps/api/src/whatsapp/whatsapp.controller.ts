import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiExcludeEndpoint, ApiOperation, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { type ChannelView, connectWhatsappSchema } from '@nexo/contracts';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import type { z } from 'zod';
import { Public } from '../auth/decorators';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { CurrentAccess, RequirePermission } from '../team/access.decorators';
import type { ResolvedAccess } from '../team/access.service';
import { ChannelsService } from './channels.service';
import { WebhookService } from './webhook.service';

const uuid = new ParseUUIDPipe();

/** Conexión de canales de WhatsApp, para quien configura la empresa. */
@ApiTags('Canales')
@ApiBearerAuth()
@Controller('channels')
export class ChannelsController {
  constructor(private readonly channels: ChannelsService) {}

  @Get()
  @RequirePermission('channel:manage')
  @ApiOperation({ summary: 'Canales conectados, con los datos para configurar Meta' })
  list(): Promise<ChannelView[]> {
    return this.channels.list();
  }

  @Post('whatsapp')
  @RequirePermission('channel:manage')
  @ApiOperation({ summary: 'Conectar un número de WhatsApp Business (Cloud API)' })
  connect(
    @CurrentAccess() access: ResolvedAccess,
    @Body(new ZodValidationPipe(connectWhatsappSchema)) body: z.infer<typeof connectWhatsappSchema>,
    @Req() req: Request,
  ): Promise<ChannelView> {
    return this.channels.connect(access, body, req);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('channel:manage')
  @ApiOperation({ summary: 'Desconectar un canal (conserva sus conversaciones)' })
  disconnect(
    @CurrentAccess() access: ResolvedAccess,
    @Param('id', uuid) id: string,
    @Req() req: Request,
  ): Promise<void> {
    return this.channels.disconnect(access, id, req);
  }
}

/**
 * Webhook de Meta. Público (lo llama Meta, sin sesión) y sin límite de tasa
 * por IP: Meta envía desde pocas IPs y en ráfagas, y cortarle sería perder
 * mensajes. La autenticidad la da la firma, no la IP.
 */
@Public()
@SkipThrottle()
@Controller('webhooks/whatsapp')
export class WhatsappWebhookController {
  constructor(private readonly webhooks: WebhookService) {}

  @Get(':channelId')
  @ApiExcludeEndpoint()
  verify(
    @Param('channelId', uuid) channelId: string,
    @Query('hub.mode') mode?: string,
    @Query('hub.verify_token') token?: string,
    @Query('hub.challenge') challenge?: string,
  ): Promise<string> {
    return this.webhooks.verify(channelId, mode, token, challenge);
  }

  @Post(':channelId')
  @HttpCode(HttpStatus.OK)
  @ApiExcludeEndpoint()
  async receive(
    @Param('channelId', uuid) channelId: string,
    @Req() req: RawBodyRequest<Request>,
    @Headers('x-hub-signature-256') signature?: string,
  ): Promise<{ received: 'nuevo' | 'repetido' }> {
    return { received: await this.webhooks.receive(channelId, req.rawBody, signature) };
  }
}
