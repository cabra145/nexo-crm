import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  type AccessView,
  inviteMemberSchema,
  type MemberView,
  roleInputSchema,
  type RolesView,
  type RoleView,
  type TeamView,
  transferOwnershipSchema,
  updateMemberSchema,
} from '@nexo/contracts';
import type { Request } from 'express';
import type { z } from 'zod';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { CurrentAccess, RequireOwner, RequirePermission } from './access.decorators';
import type { ResolvedAccess } from './access.service';
import { MembersService } from './members.service';
import { RolesService } from './roles.service';

const uuid = new ParseUUIDPipe();

@ApiTags('Equipo')
@ApiBearerAuth()
@Controller()
export class TeamController {
  constructor(
    private readonly members: MembersService,
    private readonly roles: RolesService,
  ) {}

  /* --- Acceso de la sesión ------------------------------------------------- */

  @Get('access')
  @ApiOperation({ summary: 'Rol y permisos actuales de la sesión en su empresa (en vivo)' })
  access(@CurrentAccess() access: ResolvedAccess): AccessView {
    return {
      membershipId: access.membershipId,
      userId: access.userId,
      role: access.role,
      teamName: access.teamName,
      permissions: access.permissions,
    };
  }

  /* --- Miembros -------------------------------------------------------------- */

  @Get('team/members')
  @RequirePermission('member:read')
  @ApiOperation({ summary: 'Miembros, invitaciones pendientes y plazas del plan' })
  team(): Promise<TeamView> {
    return this.members.team();
  }

  @Patch('team/members/:id')
  @RequirePermission('member:manage')
  @ApiOperation({ summary: 'Cambiar el rol o el equipo de un miembro' })
  update(
    @CurrentAccess() access: ResolvedAccess,
    @Param('id', uuid) id: string,
    @Body(new ZodValidationPipe(updateMemberSchema)) body: z.infer<typeof updateMemberSchema>,
    @Req() req: Request,
  ): Promise<MemberView> {
    return this.members.update(access, id, body, req);
  }

  @Post('team/members/:id/disable')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('member:manage')
  @ApiOperation({ summary: 'Desactivar a un miembro (pierde el acceso al instante)' })
  disable(
    @CurrentAccess() access: ResolvedAccess,
    @Param('id', uuid) id: string,
    @Req() req: Request,
  ): Promise<MemberView> {
    return this.members.setDisabled(access, id, true, req);
  }

  @Post('team/members/:id/enable')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('member:manage')
  @ApiOperation({ summary: 'Reactivar a un miembro' })
  enable(
    @CurrentAccess() access: ResolvedAccess,
    @Param('id', uuid) id: string,
    @Req() req: Request,
  ): Promise<MemberView> {
    return this.members.setDisabled(access, id, false, req);
  }

  @Delete('team/members/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('member:manage')
  @ApiOperation({ summary: 'Dar de baja a un miembro' })
  remove(
    @CurrentAccess() access: ResolvedAccess,
    @Param('id', uuid) id: string,
    @Req() req: Request,
  ): Promise<void> {
    return this.members.remove(access, id, 'member', req);
  }

  @Post('team/transfer-ownership')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequireOwner()
  @ApiOperation({ summary: 'Transferir la propiedad (contraseña + código del autenticador)' })
  transferOwnership(
    @CurrentAccess() access: ResolvedAccess,
    @Body(new ZodValidationPipe(transferOwnershipSchema))
    body: z.infer<typeof transferOwnershipSchema>,
    @Req() req: Request,
  ): Promise<void> {
    return this.members.transferOwnership(access, body, req);
  }

  /* --- Invitaciones ---------------------------------------------------------- */

  @Post('team/invitations')
  @RequirePermission('member:invite')
  @ApiOperation({ summary: 'Invitar a alguien por correo con un rol' })
  invite(
    @CurrentAccess() access: ResolvedAccess,
    @Body(new ZodValidationPipe(inviteMemberSchema)) body: z.infer<typeof inviteMemberSchema>,
    @Req() req: Request,
  ): Promise<MemberView> {
    return this.members.invite(access, body, req);
  }

  @Post('team/invitations/:id/resend')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('member:invite')
  @ApiOperation({ summary: 'Reenviar una invitación (el enlace anterior deja de valer)' })
  resend(
    @CurrentAccess() access: ResolvedAccess,
    @Param('id', uuid) id: string,
    @Req() req: Request,
  ): Promise<MemberView> {
    return this.members.resendInvitation(access, id, req);
  }

  @Delete('team/invitations/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('member:invite')
  @ApiOperation({ summary: 'Cancelar una invitación pendiente' })
  cancel(
    @CurrentAccess() access: ResolvedAccess,
    @Param('id', uuid) id: string,
    @Req() req: Request,
  ): Promise<void> {
    return this.members.remove(access, id, 'invitation', req);
  }

  /* --- Roles ----------------------------------------------------------------- */

  @Get('team/roles')
  @RequirePermission('member:read')
  @ApiOperation({ summary: 'Roles de la empresa con sus permisos' })
  listRoles(): Promise<RolesView> {
    return this.roles.list();
  }

  @Post('team/roles')
  @RequirePermission('role:manage')
  @ApiOperation({ summary: 'Crear un rol personalizado' })
  createRole(
    @CurrentAccess() access: ResolvedAccess,
    @Body(new ZodValidationPipe(roleInputSchema)) body: z.infer<typeof roleInputSchema>,
    @Req() req: Request,
  ): Promise<RoleView> {
    return this.roles.create(access, body, req);
  }

  @Patch('team/roles/:id')
  @RequirePermission('role:manage')
  @ApiOperation({ summary: 'Editar un rol personalizado' })
  updateRole(
    @CurrentAccess() access: ResolvedAccess,
    @Param('id', uuid) id: string,
    @Body(new ZodValidationPipe(roleInputSchema)) body: z.infer<typeof roleInputSchema>,
    @Req() req: Request,
  ): Promise<RoleView> {
    return this.roles.update(access, id, body, req);
  }

  @Delete('team/roles/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('role:manage')
  @ApiOperation({ summary: 'Eliminar un rol personalizado sin miembros' })
  deleteRole(
    @CurrentAccess() access: ResolvedAccess,
    @Param('id', uuid) id: string,
    @Req() req: Request,
  ): Promise<void> {
    return this.roles.remove(access, id, req);
  }
}
