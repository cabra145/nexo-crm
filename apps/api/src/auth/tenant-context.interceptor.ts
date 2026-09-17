import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import { runWithTenantContext } from '@nexo/database';
import { Observable } from 'rxjs';
import type { AuthenticatedRequest } from './decorators';
import { traceIdOf } from '../common/trace-id';

/**
 * Fija el contexto de empresa para TODO lo que ocurre dentro de una petición
 * autenticada: consultas, trabajos que se encolen, logs.
 *
 * Es la capa 1 del aislamiento (docs/arquitectura.md). La empresa sale del
 * token de acceso firmado, nunca de un parámetro que envíe el cliente.
 */
@Injectable()
export class TenantContextInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (!req.auth) return next.handle();

    return new Observable((subscriber) => {
      runWithTenantContext(
        {
          tenantId: req.auth.tid,
          userId: req.auth.sub,
          membershipId: req.auth.mid,
          actorType: 'USER',
          traceId: traceIdOf(req),
          ip: req.ip,
          userAgent: req.headers['user-agent'],
        },
        () => next.handle().subscribe(subscriber),
      );
    });
  }
}
