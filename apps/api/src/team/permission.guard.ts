import { type CanActivate, type ExecutionContext, HttpStatus, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PERMISSIONS, type Permission, PROBLEM_TYPES, TEAM_PROBLEMS } from '@nexo/contracts';
import { ProblemException } from '../common/problem.exception';
import { type AuthenticatedRequest, IS_PUBLIC } from '../auth/decorators';
import {
  REQUIRE_OWNER,
  REQUIRED_PERMISSIONS,
  type RequestWithAccess,
  SKIP_MEMBERSHIP_CHECK,
} from './access.decorators';
import { AccessService } from './access.service';

/**
 * Guard global de autorización. Corre DESPUÉS del de autenticación.
 *
 *   1. Toda ruta autenticada exige que la membresía del token siga ACTIVA en
 *      su empresa, leída en vivo: un miembro desactivado o eliminado pierde
 *      el acceso en la siguiente petición, no cuando caduque su token.
 *   2. `@RequirePermission(...)` exige esos permisos al rol ACTUAL.
 *   3. `@RequireOwner()` exige ser el propietario.
 *
 * El alcance (qué filas) no se decide aquí: lo aplica cada servicio con
 * `access.permissions[permiso]`.
 */
@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly accessService: AccessService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;
    if (this.reflector.getAllAndOverride<boolean>(SKIP_MEMBERSHIP_CHECK, targets)) return true;

    const req = context.switchToHttp().getRequest<AuthenticatedRequest & RequestWithAccess>();
    // Sin sesión aquí sólo se llega si el guard de autenticación dejó pasar
    // (ruta pública). Por si alguien reordena los guards: se deniega.
    if (!req.auth) throw forbidden('Falta la sesión.');

    const access = await this.accessService.resolve(req.auth.tid, req.auth.mid);
    if (!access || access.status !== 'ACTIVE' || access.userId !== req.auth.sub) {
      // 401 y no 403: la web renueva la sesión, que ya no incluirá esta
      // empresa, y el usuario acaba en otra suya o en el inicio de sesión.
      throw new ProblemException({
        type: TEAM_PROBLEMS.MEMBERSHIP_INACTIVE,
        title: 'Ya no tienes acceso a esta empresa',
        status: HttpStatus.UNAUTHORIZED,
        detail: 'Tu acceso a esta empresa se desactivó o se retiró.',
      });
    }
    req.access = access;

    if (this.reflector.getAllAndOverride<boolean>(REQUIRE_OWNER, targets)) {
      if (access.role.key !== 'OWNER') {
        throw forbidden('Sólo el propietario de la empresa puede hacer esto.');
      }
    }

    const required = this.reflector.getAllAndOverride<Permission[]>(REQUIRED_PERMISSIONS, targets);
    const missing = (required ?? []).filter((p) => !access.permissions[p]);
    if (missing.length > 0) {
      throw forbidden(
        `Tu rol no permite: ${missing.map((p) => PERMISSIONS[p].toLowerCase()).join(', ')}.`,
      );
    }

    return true;
  }
}

function forbidden(detail: string): ProblemException {
  return new ProblemException({
    type: PROBLEM_TYPES.FORBIDDEN,
    title: 'No tienes permiso',
    status: HttpStatus.FORBIDDEN,
    detail,
  });
}
