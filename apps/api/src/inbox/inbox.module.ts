import { Module } from '@nestjs/common';
import { RealtimeModule } from '../realtime/realtime.module';
import { TeamModule } from '../team/team.module';
import { WhatsappModule } from '../whatsapp/whatsapp.module';
import { InboxController } from './inbox.controller';
import { InboxService } from './inbox.service';

@Module({
  imports: [TeamModule, RealtimeModule, WhatsappModule],
  controllers: [InboxController],
  providers: [InboxService],
})
export class InboxModule {}
