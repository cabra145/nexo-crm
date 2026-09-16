import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { PROBLEM_TYPES, type ApiProblem } from '@nexo/contracts';
import { Prisma } from '@nexo/database';
import type { Request, Response } from 'express';
import { ValidationException } from '../pipes/zod-validation.pipe';

/**
 * Todo error que sale de la API tiene la misma forma: RFC 7807 más `traceId`
 * y, si procede, `errors[]` por campo.
 *
 * Dos reglas que este filtro hace cumplir:
 *
 *  1. Un error 500 NUNCA filtra detalles internos al cliente — ni el mensaje
 *     de Postgres, ni la pila, ni nombres de tabla. Eso va al log.
 *  2. Todo error lleva `traceId`. La interfaz lo muestra, y soporte encuentra
 *     la traza exacta sin pedirle capturas al usuario.
 */
@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  private readonly logger = new Logger('Errores');

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<Request & { id?: string | number }>();
    const response = http.getResponse<Response>();

    const traceId = request.id !== undefined ? String(request.id) : undefined;
    const problem = this.toProblem(exception);
    problem.traceId = traceId;

    if (problem.status >= 500) {
      this.logger.error(
        `${request.method} ${request.originalUrl} → ${problem.status} [${traceId ?? 'sin traza'}]`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    }

    if (response.headersSent) return;

    response.status(problem.status).type('application/problem+json').json(problem);
  }

  private toProblem(exception: unknown): ApiProblem {
    // --- Validación de nuestros esquemas --------------------------------
    if (exception instanceof ValidationException) {
      return {
        type: PROBLEM_TYPES.VALIDATION,
        title: 'Datos no válidos',
        status: HttpStatus.BAD_REQUEST,
        detail: 'Revisa los campos marcados.',
        errors: exception.errors,
      };
    }

    // --- Prisma: errores conocidos con significado para el usuario ------
    if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      switch (exception.code) {
        case 'P2002': {
          const target = exception.meta?.target;
          const fields = Array.isArray(target) ? target.join(', ') : String(target ?? '');
          return {
            type: PROBLEM_TYPES.CONFLICT,
            title: 'Registro duplicado',
            status: HttpStatus.CONFLICT,
            detail: fields
              ? `Ya existe un registro con ese valor en: ${fields}.`
              : 'Ya existe un registro con esos datos.',
          };
        }
        case 'P2025':
          return {
            type: PROBLEM_TYPES.NOT_FOUND,
            title: 'No encontrado',
            status: HttpStatus.NOT_FOUND,
            detail: 'El registro no existe o no tienes acceso a él.',
          };
        case 'P2003':
          return {
            type: PROBLEM_TYPES.CONFLICT,
            title: 'Registro relacionado',
            status: HttpStatus.CONFLICT,
            detail: 'No se puede completar: hay otros registros que dependen de éste.',
          };
      }
    }

    // --- Excepciones HTTP de Nest ---------------------------------------
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      const detail =
        typeof body === 'string'
          ? body
          : Array.isArray((body as { message?: unknown }).message)
            ? ((body as { message: string[] }).message).join('. ')
            : String((body as { message?: unknown }).message ?? exception.message);

      return {
        type: typeForStatus(status),
        title: titleForStatus(status),
        status,
        detail,
      };
    }

    // --- Cualquier otra cosa: 500 sin detalles --------------------------
    return {
      type: PROBLEM_TYPES.INTERNAL,
      title: 'Error interno',
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      detail:
        'Algo falló de nuestro lado. Si vuelve a pasar, comparte el identificador de traza con soporte.',
    };
  }
}

function typeForStatus(status: number): string {
  switch (status) {
    case 400: return PROBLEM_TYPES.VALIDATION;
    case 401: return PROBLEM_TYPES.UNAUTHORIZED;
    case 402: return PROBLEM_TYPES.QUOTA_EXCEEDED;
    case 403: return PROBLEM_TYPES.FORBIDDEN;
    case 404: return PROBLEM_TYPES.NOT_FOUND;
    case 409: return PROBLEM_TYPES.CONFLICT;
    case 429: return PROBLEM_TYPES.RATE_LIMITED;
    default: return status >= 500 ? PROBLEM_TYPES.INTERNAL : 'about:blank';
  }
}

function titleForStatus(status: number): string {
  switch (status) {
    case 400: return 'Petición no válida';
    case 401: return 'Sesión no iniciada';
    case 402: return 'Límite del plan alcanzado';
    case 403: return 'Sin permiso';
    case 404: return 'No encontrado';
    case 409: return 'Conflicto';
    case 429: return 'Demasiadas peticiones';
    default: return status >= 500 ? 'Error interno' : 'Error';
  }
}
