import { Module } from '@nestjs/common';
import { TeamModule } from '../team/team.module';
import { ChannelsService } from './channels.service';
import { GraphClient } from './graph.client';
import { TemplatesService } from './templates.service';
import { WebhookService } from './webhook.service';
import { ChannelsController, WhatsappWebhookController } from './whatsapp.controller';

@Module({
  imports: [TeamModule],
  controllers: [ChannelsController, WhatsappWebhookController],
  providers: [GraphClient, ChannelsService, WebhookService, TemplatesService],
  exports: [TemplatesService],
})
export class WhatsappModule {}
