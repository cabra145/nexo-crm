import { Module } from '@nestjs/common';
import { RealtimeModule } from '../realtime/realtime.module';
import { TeamModule } from '../team/team.module';
import { InboxController } from './inbox.controller';
import { InboxService } from './inbox.service';

@Module({
  imports: [TeamModule, RealtimeModule],
  controllers: [InboxController],
  providers: [InboxService],
})
export class InboxModule {}
