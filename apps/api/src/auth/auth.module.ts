import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { CsrfGuard } from './csrf.guard';
import { EmailTokensService } from './email-tokens.service';
import { AccessTokenGuard } from './guards/access-token.guard';
import { RateLimiterService } from './rate-limiter.service';
import { SessionService } from './session.service';
import { TenantContextInterceptor } from './tenant-context.interceptor';
import { TwoFactorService } from './two-factor.service';

@Module({
  // Los secretos se pasan en cada firma y verificación, no aquí: el token de
  // acceso y el desafío 2FA usan secretos DISTINTOS, y así no hay uno "por
  // defecto" que se pueda usar por error.
  imports: [JwtModule.register({})],
  controllers: [AuthController],
  providers: [
    AuthService,
    SessionService,
    TwoFactorService,
    EmailTokensService,
    RateLimiterService,
    CsrfGuard,
    AccessTokenGuard,
    TenantContextInterceptor,
  ],
  exports: [SessionService, AccessTokenGuard, TenantContextInterceptor],
})
export class AuthModule {}
