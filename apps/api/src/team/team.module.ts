import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AccessService } from './access.service';
import { InvitationsController } from './invitations.controller';
import { MembersService } from './members.service';
import { PermissionGuard } from './permission.guard';
import { RolesService } from './roles.service';
import { TeamController } from './team.controller';

@Module({
  imports: [AuthModule],
  controllers: [TeamController, InvitationsController],
  providers: [AccessService, PermissionGuard, MembersService, RolesService],
  exports: [AccessService, PermissionGuard],
})
export class TeamModule {}
