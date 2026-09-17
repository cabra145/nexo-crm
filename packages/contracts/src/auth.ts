import { z } from 'zod';
import { emailSchema, passwordSchema, slugSchema } from './common';

/**
 * Contrato de la autenticación.
 *
 * Los mismos esquemas validan el formulario en el navegador y la petición en
 * la API, así que una regla (longitud de contraseña, formato del código 2FA)
 * no puede divergir entre los dos lados.
 */

/* ========================================================================== */
/*  Tiempos                                                                    */
/* ========================================================================== */

export const AUTH_TIMINGS = {
  /** Vida del token de acceso. Corto: no se puede revocar antes de que caduque. */
  accessTokenSeconds: 15 * 60,
  /** Vida del token de refresco. Se renueva (rota) en cada uso. */
  refreshTokenDays: 30,
  /** Verificación de correo. */
  emailVerificationHours: 24,
  /** Recuperación de contraseña. Corto: es una llave de la cuenta. */
  passwordResetMinutes: 60,
  /** Entre la contraseña correcta y el código 2FA. */
  twoFactorChallengeMinutes: 5,
  /** Plazo que tiene un propietario para activar el 2FA. */
  ownerTwoFactorGraceDays: 7,
} as const;

/** Nombre de la cookie httpOnly del token de refresco. */
export const REFRESH_COOKIE = 'nexo_rt';

/**
 * Cabecera que la web envía en las rutas que usan la cookie de sesión.
 *
 * Es la defensa contra CSRF: un formulario de otro sitio puede hacer que el
 * navegador envíe la cookie, pero no puede añadir una cabecera propia sin una
 * petición previa de CORS, que la API sólo acepta desde el origen de la web.
 */
export const CLIENT_HEADER = 'x-nexo-client';
export const CLIENT_HEADER_VALUE = 'web';

/* ========================================================================== */
/*  Peticiones                                                                 */
/* ========================================================================== */

export const registerSchema = z.object({
  name: z.string().trim().min(2, 'escribe tu nombre').max(120),
  email: emailSchema,
  password: passwordSchema,
  companyName: z.string().trim().min(2, 'escribe el nombre de tu empresa').max(160),
  /** Opcional: si no llega, se genera a partir del nombre de la empresa. */
  slug: slugSchema.optional(),
});
export type RegisterInput = z.infer<typeof registerSchema>;

export const verifyEmailSchema = z.object({
  token: z.string().min(32).max(128),
});

export const emailOnlySchema = z.object({
  email: emailSchema,
});

export const loginSchema = z.object({
  email: emailSchema,
  // En el login NO se aplican las reglas de fortaleza: una contraseña antigua
  // que ya no las cumpliría tiene que poder usarse para entrar y cambiarla.
  password: z.string().min(1, 'escribe tu contraseña').max(128),
  /** Empresa en la que entrar, si el usuario pertenece a varias. */
  tenantSlug: z.string().max(63).optional(),
});
export type LoginInput = z.infer<typeof loginSchema>;

const totpCode = z
  .string()
  .trim()
  .regex(/^\d{6}$/, 'el código tiene 6 dígitos');

const recoveryCode = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9]{5}-[A-Z0-9]{5}$/, 'formato de código de recuperación: XXXXX-XXXXX');

export const loginTwoFactorSchema = z
  .object({
    challengeToken: z.string().min(20),
    code: totpCode.optional(),
    recoveryCode: recoveryCode.optional(),
  })
  .refine((v) => Boolean(v.code) !== Boolean(v.recoveryCode), {
    message: 'envía el código del autenticador o un código de recuperación, uno de los dos',
    path: ['code'],
  });

export const enableTwoFactorSchema = z.object({ code: totpCode });

export const disableTwoFactorSchema = z.object({
  password: z.string().min(1).max(128),
  code: totpCode,
});

export const resetPasswordSchema = z.object({
  token: z.string().min(32).max(128),
  password: passwordSchema,
});

export const switchTenantSchema = z.object({
  tenantId: z.string().uuid(),
});

/* ========================================================================== */
/*  Respuestas                                                                 */
/* ========================================================================== */

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  avatarUrl: string | null;
  twoFactorEnabled: boolean;
}

export interface SessionMembership {
  membershipId: string;
  tenantId: string;
  tenantSlug: string;
  tenantName: string;
  role: 'OWNER' | 'ADMIN' | 'MANAGER' | 'AGENT' | 'VIEWER' | 'CUSTOM';
  roleName: string;
}

export interface TwoFactorRequirement {
  /** El rol en la empresa activa exige 2FA. */
  required: boolean;
  enabled: boolean;
  /** Hasta cuándo puede usar el producto sin activarlo. Null si no aplica. */
  deadline: string | null;
  /** El plazo venció: sólo puede acceder a la configuración del 2FA. */
  blocked: boolean;
}

export interface SessionResponse {
  accessToken: string;
  /** Segundos hasta que caduca el token de acceso. */
  expiresIn: number;
  user: SessionUser;
  activeTenant: SessionMembership;
  memberships: SessionMembership[];
  twoFactor: TwoFactorRequirement;
}

/** Contraseña correcta, falta el segundo factor. */
export interface TwoFactorChallengeResponse {
  requiresTwoFactor: true;
  challengeToken: string;
  expiresIn: number;
}

export type LoginResponse = SessionResponse | TwoFactorChallengeResponse;

export interface TwoFactorSetupResponse {
  /** URI otpauth:// para el código QR. */
  otpauthUrl: string;
  /** El mismo secreto en base32, para introducirlo a mano. */
  secret: string;
}

export interface TwoFactorEnabledResponse {
  /** Se muestran UNA sola vez. Sólo se guarda su hash. */
  recoveryCodes: string[];
  session: SessionResponse;
}

/** Códigos de error de la autenticación, en `ApiProblem.type`. */
export const AUTH_PROBLEMS = {
  INVALID_CREDENTIALS: 'https://nexo.app/problems/credenciales-invalidas',
  EMAIL_NOT_VERIFIED: 'https://nexo.app/problems/correo-sin-verificar',
  TWO_FACTOR_INVALID: 'https://nexo.app/problems/codigo-2fa-invalido',
  TWO_FACTOR_REQUIRED: 'https://nexo.app/problems/2fa-obligatorio',
  SESSION_EXPIRED: 'https://nexo.app/problems/sesion-caducada',
  TOKEN_INVALID: 'https://nexo.app/problems/enlace-invalido',
  TENANT_UNAVAILABLE: 'https://nexo.app/problems/empresa-no-disponible',
  ACCOUNT_DISABLED: 'https://nexo.app/problems/cuenta-desactivada',
} as const;
