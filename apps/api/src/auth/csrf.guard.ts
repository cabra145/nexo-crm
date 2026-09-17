import {
  type CanActivate,
  type ExecutionContext,
  HttpStatus,
  Inject,
  Injectable,
} from '@nestjs/common';
import { CLIENT_HEADER, CLIENT_HEADER_VALUE, PROBLEM_TYPES, type ApiEnv } from '@nexo/contracts';
import type { Request } from 'express';
import { ProblemException } from '../common/problem.exception';
import { API_ENV } from '../config/config.module';

/**
 * Protección CSRF para las rutas que actúan con la COOKIE de sesión (refrescar,
 * cambiar de empresa, cerrar sesión).
 *
 * Dos comprobaciones independientes:
 *  1. Cabecera propia `x-nexo-client: web`. Un formulario o una imagen de otro
 *     sitio no pueden añadirla; un `fetch` de otro sitio sí, pero eso obliga
 *     al navegador a pedir permiso por CORS, que sólo se concede a la web.
 *  2. Si el navegador envía `Origin`, tiene que ser el de la web.
 */
@Injectable()
export class CsrfGuard implements CanActivate {
  constructor(@Inject(API_ENV) private readonly env: ApiEnv) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    const origin = req.headers.origin;
    const allowedOrigin = new URL(this.env.APP_URL).origin;

    if (
      req.headers[CLIENT_HEADER] !== CLIENT_HEADER_VALUE ||
      (origin && origin !== allowedOrigin)
    ) {
      throw new ProblemException({
        type: PROBLEM_TYPES.FORBIDDEN,
        title: 'Petición rechazada',
        status: HttpStatus.FORBIDDEN,
        detail: 'Esta operación sólo se puede hacer desde la aplicación web.',
      });
    }
    return true;
  }
}
