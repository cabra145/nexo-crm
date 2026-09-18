import { Controller, Get, Req, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { CurrentAuth } from '../auth/decorators';
import type { AccessTokenClaims } from '../auth/session.service';
import { CurrentAccess, RequirePermission } from '../team/access.decorators';
import type { ResolvedAccess } from '../team/access.service';
import { RealtimeService } from './realtime.service';

/** Latido: mantiene viva la conexión a través de proxies que cortan lo inactivo. */
const HEARTBEAT_MS = 25_000;

/**
 * Avisos en tiempo real por Server-Sent Events.
 *
 * Autenticado con el token de acceso en la cabecera, como cualquier petición
 * (la web usa `fetch` con streaming, no `EventSource`, que no permite
 * cabeceras). La conexión se CIERRA cuando caduca ese token: la web se
 * reconecta con uno renovado, y así una sesión cerrada o una empresa
 * abandonada no siguen recibiendo avisos indefinidamente.
 *
 * Al conectar (y al reconectar) la web vuelve a pedir lo que muestra, así que
 * un aviso perdido durante un corte no deja la pantalla desfasada.
 */
@ApiTags('Bandeja')
@ApiBearerAuth()
@Controller('realtime')
export class RealtimeController {
  constructor(private readonly realtime: RealtimeService) {}

  @Get('stream')
  // Una conexión larga es UNA petición; el límite por minuto no aplica.
  @SkipThrottle()
  @RequirePermission('conversation:read')
  @ApiOperation({ summary: 'Avisos de cambios en conversaciones (text/event-stream)' })
  stream(
    @CurrentAccess() access: ResolvedAccess,
    @CurrentAuth() auth: AccessTokenClaims,
    @Req() req: Request,
    @Res() res: Response,
  ): void {
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    // Nginx almacena las respuestas por defecto: sin esto los avisos llegarían
    // en bloques, con retraso.
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    let closed = false;
    const write = (chunk: string) => {
      if (!closed) res.write(chunk);
    };

    const unregister = this.realtime.register({
      tenantId: access.tenantId,
      membershipId: access.membershipId,
      userId: access.userId,
      send: (event) => write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`),
      close: () => finish(),
    });

    const heartbeat = setInterval(() => write(': latido\n\n'), HEARTBEAT_MS);
    const exp = (auth as AccessTokenClaims & { exp?: number }).exp;
    const expiry = exp
      ? setTimeout(() => finish(), Math.max(0, exp * 1000 - Date.now()))
      : undefined;

    function finish(): void {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      if (expiry) clearTimeout(expiry);
      unregister();
      res.end();
    }

    req.on('close', finish);
    // Primer mensaje: confirma a la web que el canal está abierto.
    write('event: ready\ndata: {}\n\n');
  }
}
