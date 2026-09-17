import { createParamDecorator, type ExecutionContext, SetMetadata } from '@nestjs/common';
import type { Request } from 'express';
import type { AccessTokenClaims } from './session.service';

export const IS_PUBLIC = 'nexo:is-public';
export const ALLOW_PENDING_TWO_FACTOR = 'nexo:allow-pending-2fa';

/**
 * Ruta sin sesión. TODAS las rutas exigen sesión por defecto: olvidarse de
 * protegerlas no es posible, olvidarse de abrirlas sólo da un 401 evidente.
 */
export const Public = () => SetMetadata(IS_PUBLIC, true);

/**
 * Ruta accesible aunque el plazo del 2FA obligatorio haya vencido: las
 * necesarias para CONFIGURARLO (y para saber que hay que hacerlo).
 */
export const AllowWhileTwoFactorPending = () => SetMetadata(ALLOW_PENDING_TWO_FACTOR, true);

export type AuthenticatedRequest = Request & { auth: AccessTokenClaims };

/** La sesión de la petición actual: `@CurrentAuth() auth: AccessTokenClaims`. */
export const CurrentAuth = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): AccessTokenClaims =>
    ctx.switchToHttp().getRequest<AuthenticatedRequest>().auth,
);
