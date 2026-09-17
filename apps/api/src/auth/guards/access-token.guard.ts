import { type CanActivate, type ExecutionContext, HttpStatus, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AUTH_PROBLEMS } from '@nexo/contracts';
import type { Request } from 'express';
import { ProblemException } from '../../common/problem.exception';
import { ALLOW_PENDING_TWO_FACTOR, type AuthenticatedRequest, IS_PUBLIC } from '../decorators';
import { SessionService } from '../session.service';

/**
 * Guard global: toda ruta exige un token de acceso válido salvo `@Public()`.
 *
 * El token viaja en `Authorization: Bearer`, no en cookie: la web lo guarda en
 * memoria, así que un XSS no lo puede leer de ningún almacén persistente, y
 * una petición forjada desde otro sitio no lo lleva.
 */
@Injectable()
export class AccessTokenGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly sessions: SessionService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;

    const req = context.switchToHttp().getRequest<Request>();
    const header = req.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice(7) : null;

    if (!token) throw unauthorized('Falta el token de sesión.');

    try {
      (req as AuthenticatedRequest).auth = await this.sessions.verifyAccessToken(token);
    } catch {
      throw unauthorized('La sesión caducó o no es válida.');
    }

    const auth = (req as AuthenticatedRequest).auth;
    if (
      auth.tfa === 'blocked' &&
      !this.reflector.getAllAndOverride<boolean>(ALLOW_PENDING_TWO_FACTOR, targets)
    ) {
      throw new ProblemException({
        type: AUTH_PROBLEMS.TWO_FACTOR_REQUIRED,
        title: 'Activa la verificación en dos pasos',
        status: HttpStatus.FORBIDDEN,
        detail:
          'Como propietario de la empresa, necesitas la verificación en dos pasos para seguir. ' +
          'Actívala en tu perfil: tarda un minuto.',
      });
    }

    return true;
  }
}

function unauthorized(detail: string): ProblemException {
  return new ProblemException({
    type: AUTH_PROBLEMS.SESSION_EXPIRED,
    title: 'Sesión no iniciada',
    status: HttpStatus.UNAUTHORIZED,
    detail,
  });
}
