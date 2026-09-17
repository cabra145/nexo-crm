import { HttpException } from '@nestjs/common';
import type { ApiProblem } from '@nexo/contracts';

/**
 * Error con un tipo de problema RFC 7807 propio.
 *
 * Una `UnauthorizedException` genérica sólo da un código 401; la web necesita
 * distinguir "credenciales incorrectas" de "correo sin verificar" o "2FA
 * obligatorio" para mostrar la pantalla correcta. El filtro de errores
 * respeta el `type` de esta excepción tal cual.
 */
export class ProblemException extends HttpException {
  constructor(
    readonly problem: Omit<ApiProblem, 'traceId'>,
    readonly headers: Record<string, string> = {},
  ) {
    super(problem.detail ?? problem.title, problem.status);
  }
}
