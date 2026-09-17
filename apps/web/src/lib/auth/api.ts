import type {
  LoginInput,
  LoginResponse,
  RegisterInput,
  SessionMembership,
  SessionResponse,
  SessionUser,
  TwoFactorEnabledResponse,
  TwoFactorRequirement,
  TwoFactorSetupResponse,
} from '@nexo/contracts';
import { apiFetch } from '@/lib/api/client';

/** Llamadas de autenticación, con los tipos del contrato compartido con la API. */
export const authApi = {
  register: (input: RegisterInput) =>
    apiFetch<{ message: string }>('/auth/register', { method: 'POST', body: input }),

  verifyEmail: (token: string) =>
    apiFetch<{ message: string }>('/auth/verify-email', { method: 'POST', body: { token } }),

  resendVerification: (email: string) =>
    apiFetch<{ message: string }>('/auth/verify-email/resend', { method: 'POST', body: { email } }),

  login: (input: LoginInput) =>
    apiFetch<LoginResponse>('/auth/login', { method: 'POST', body: input }),

  loginTwoFactor: (input: { challengeToken: string; code?: string; recoveryCode?: string }) =>
    apiFetch<SessionResponse>('/auth/login/2fa', { method: 'POST', body: input }),

  forgotPassword: (email: string) =>
    apiFetch<{ message: string }>('/auth/password/forgot', { method: 'POST', body: { email } }),

  resetPassword: (token: string, password: string) =>
    apiFetch<{ message: string }>('/auth/password/reset', {
      method: 'POST',
      body: { token, password },
    }),

  me: () =>
    apiFetch<{
      user: SessionUser;
      activeTenant: SessionMembership | null;
      memberships: SessionMembership[];
      twoFactor: TwoFactorRequirement | null;
    }>('/auth/me', { auth: true }),

  switchTenant: (tenantId: string) =>
    apiFetch<SessionResponse>('/auth/switch-tenant', {
      method: 'POST',
      body: { tenantId },
      auth: true,
      sessionCookie: true,
    }),

  setupTwoFactor: () =>
    apiFetch<TwoFactorSetupResponse>('/auth/2fa/setup', { method: 'POST', auth: true }),

  enableTwoFactor: (code: string) =>
    apiFetch<TwoFactorEnabledResponse>('/auth/2fa/enable', {
      method: 'POST',
      body: { code },
      auth: true,
      sessionCookie: true,
    }),

  disableTwoFactor: (password: string, code: string) =>
    apiFetch<void>('/auth/2fa/disable', { method: 'POST', body: { password, code }, auth: true }),
};

/**
 * Destino tras iniciar sesión, validado: sólo rutas internas.
 *
 * `?next=//sitio-malicioso.com` o `?next=https://…` son redirecciones abiertas
 * clásicas: un enlace legítimo de login que, tras entrar, lleva a una copia
 * falsa del producto. Sólo se acepta una ruta que empiece por `/` y no por `//`.
 */
export function safeNext(next: string | null | undefined, fallback: string): string {
  if (!next || !next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\'))
    return fallback;
  return next;
}
