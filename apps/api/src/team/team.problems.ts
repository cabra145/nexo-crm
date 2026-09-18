import { HttpStatus } from '@nestjs/common';
import { PROBLEM_TYPES, TEAM_PROBLEMS } from '@nexo/contracts';
import { ProblemException } from '../common/problem.exception';

export const notFound = (what: string) =>
  new ProblemException({
    type: PROBLEM_TYPES.NOT_FOUND,
    title: `${what} no encontrado`,
    status: HttpStatus.NOT_FOUND,
  });

export const escalation = (detail: string) =>
  new ProblemException({
    type: TEAM_PROBLEMS.ESCALATION,
    title: 'No puedes conceder más permisos de los que tienes',
    status: HttpStatus.FORBIDDEN,
    detail,
  });

export const ownerProtected = () =>
  new ProblemException({
    type: TEAM_PROBLEMS.OWNER_PROTECTED,
    title: 'El propietario no se puede modificar',
    status: HttpStatus.FORBIDDEN,
    detail:
      'El rol de propietario sólo cambia de manos con «Transferir la propiedad», que hace el propio propietario.',
  });

export const selfChange = () =>
  new ProblemException({
    type: TEAM_PROBLEMS.SELF_CHANGE,
    title: 'No puedes cambiar tu propio acceso',
    status: HttpStatus.FORBIDDEN,
    detail: 'Pide a otra persona con permiso que lo haga.',
  });

/** Nota o dato de otra persona: no se reescribe lo que otro anotó. */
export const notYours = (detail: string) =>
  new ProblemException({
    type: PROBLEM_TYPES.FORBIDDEN,
    title: 'No puedes modificar esto',
    status: HttpStatus.FORBIDDEN,
    detail,
  });

export const conflict = (title: string, detail?: string, type: string = PROBLEM_TYPES.CONFLICT) =>
  new ProblemException({ type, title, status: HttpStatus.CONFLICT, detail });

export const seatLimit = (limit: number) =>
  new ProblemException({
    type: TEAM_PROBLEMS.SEAT_LIMIT,
    title: 'Has llegado al límite de usuarios de tu plan',
    status: HttpStatus.FORBIDDEN,
    detail: `Tu plan incluye ${limit} usuarios, contando las invitaciones pendientes. Desactiva a alguien, cancela una invitación o mejora el plan.`,
  });

export const featureUnavailable = (detail: string) =>
  new ProblemException({
    type: TEAM_PROBLEMS.FEATURE_UNAVAILABLE,
    title: 'Tu plan no incluye esta función',
    status: HttpStatus.FORBIDDEN,
    detail,
  });
