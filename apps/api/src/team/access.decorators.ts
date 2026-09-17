import { createParamDecorator, type ExecutionContext, SetMetadata } from '@nestjs/common';
import type { Permission } from '@nexo/contracts';
import type { Request } from 'express';
import type { ResolvedAccess } from './access.service';

export const REQUIRED_PERMISSIONS = 'nexo:required-permissions';
export const REQUIRE_OWNER = 'nexo:require-owner';
export const SKIP_MEMBERSHIP_CHECK = 'nexo:skip-membership-check';

/**
 * Permisos que exige la ruta (todos). Sin este decorador, una ruta autenticada
 * sólo exige ser miembro ACTIVO de la empresa del token.
 */
export const RequirePermission = (...permissions: Permission[]) =>
  SetMetadata(REQUIRED_PERMISSIONS, permissions);

/** Sólo el propietario: acciones que no se delegan con permisos (transferir la propiedad). */
export const RequireOwner = () => SetMetadata(REQUIRE_OWNER, true);

/**
 * La ruta actúa sobre el USUARIO, no sobre la empresa del token (sesión, 2FA,
 * cambio de empresa). Tiene que seguir funcionando aunque ya no pertenezca a
 * esa empresa: si no, quien pierde el acceso a una no podría cambiar a otra.
 */
export const SkipMembershipCheck = () => SetMetadata(SKIP_MEMBERSHIP_CHECK, true);

export type RequestWithAccess = Request & { access?: ResolvedAccess };

/** Acceso resuelto de la petición: `@CurrentAccess() access: ResolvedAccess`. */
export const CurrentAccess = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): ResolvedAccess => {
    const access = ctx.switchToHttp().getRequest<RequestWithAccess>().access;
    if (!access) {
      throw new Error('@CurrentAccess() en una ruta sin comprobación de membresía');
    }
    return access;
  },
);
