import { z } from 'zod';

/**
 * Validación de la configuración de entorno.
 *
 * Se ejecuta al ARRANCAR, antes de aceptar tráfico. Si falta una variable o
 * tiene mal formato, el proceso no levanta y dice exactamente cuál y por qué.
 *
 * El motivo es simple: un secreto ausente descubierto a las tres horas de
 * despliegue, cuando el primer cliente intenta enviar un WhatsApp, cuesta
 * infinitamente más que un arranque fallido en dos segundos.
 */

const nonEmpty = (name: string) => z.string().min(1, `${name} no puede estar vacío`);

/** Clave simétrica de 32 bytes en hexadecimal (64 caracteres). */
const hex32 = z
  .string()
  .regex(/^[0-9a-fA-F]{64}$/, 'debe ser una clave de 32 bytes en hexadecimal (64 caracteres). Genérala con: openssl rand -hex 32');

const port = z.coerce.number().int().min(1).max(65_535);

/**
 * Remitente de correo. Acepta las dos formas habituales:
 *   no-responder@nexo.app
 *   Nexo CRM <no-responder@nexo.app>
 * La segunda es la que muestra un nombre legible en la bandeja del destinatario.
 */
const mailFrom = z
  .string()
  .trim()
  .refine(
    (v) => {
      const address = v.match(/<([^<>]+)>\s*$/)?.[1] ?? v;
      return z.string().email().safeParse(address.trim()).success;
    },
    { message: 'debe ser un correo, o "Nombre <correo>", p. ej. "Nexo CRM <no-responder@nexo.app>"' },
  );

const bool = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');

/* ========================================================================== */
/*  Común a todos los procesos                                                */
/* ========================================================================== */

const baseSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  /** Conexión de la aplicación. Rol `nexo_app`: SIN BYPASSRLS. */
  DATABASE_URL: nonEmpty('DATABASE_URL').url(),

  /**
   * Conexión directa con el rol dueño, para migraciones y scripts SQL.
   * En desarrollo puede ser la misma; en producción NO debe serlo, porque el
   * rol de la aplicación no debe poder alterar el esquema.
   */
  DIRECT_DATABASE_URL: z.string().url().optional(),

  REDIS_URL: nonEmpty('REDIS_URL').url(),

  /** Clave maestra de cifrado en reposo: tokens de Meta, secretos TOTP, webhooks. */
  ENCRYPTION_KEY: hex32,

  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
});

/* ========================================================================== */
/*  API                                                                        */
/* ========================================================================== */

export const apiEnvSchema = baseSchema.extend({
  API_PORT: port.default(4000),

  /**
   * Secretos de firma. DISTINTOS entre sí a propósito: si se filtra el de
   * acceso, no sirve para forjar un token de refresco.
   */
  JWT_ACCESS_SECRET: nonEmpty('JWT_ACCESS_SECRET').min(32, 'mínimo 32 caracteres'),
  JWT_REFRESH_SECRET: nonEmpty('JWT_REFRESH_SECRET').min(32, 'mínimo 32 caracteres'),

  JWT_ACCESS_TTL: z.string().default('15m'),
  JWT_REFRESH_TTL: z.string().default('30d'),

  /** Origen de la web, para CORS y para los enlaces de los correos. */
  APP_URL: nonEmpty('APP_URL').url(),
  /** Dominio de la cookie de refresco. Vacío = host actual. */
  COOKIE_DOMAIN: z.string().optional(),

  /** Correo transaccional. Sin esto no hay verificación ni recuperación. */
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: port.optional(),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  SMTP_FROM: mailFrom.optional(),

  /** Almacenamiento de objetos, compatible S3 (MinIO en local). */
  S3_ENDPOINT: z.string().url().optional(),
  S3_REGION: z.string().default('us-east-1'),
  S3_BUCKET: z.string().default('nexo'),
  S3_ACCESS_KEY: z.string().optional(),
  S3_SECRET_KEY: z.string().optional(),
  S3_FORCE_PATH_STYLE: bool.default('true'),

  /** Fase 3. Vacío = el módulo de IA queda desactivado, no roto. */
  OPENAI_API_KEY: z.string().optional(),

  /** Fase 2. Verificación del webhook de Meta. */
  META_WEBHOOK_VERIFY_TOKEN: z.string().optional(),
  META_APP_SECRET: z.string().optional(),
  META_GRAPH_VERSION: z.string().default('v21.0'),

  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(300),

  SENTRY_DSN: z.string().optional(),
});

export type ApiEnv = z.infer<typeof apiEnvSchema>;

/* ========================================================================== */
/*  Worker                                                                     */
/* ========================================================================== */

export const workerEnvSchema = baseSchema.extend({
  WORKER_CONCURRENCY: z.coerce.number().int().positive().default(10),
  /**
   * Puerto de la sonda de salud del worker. Sólo escucha en 127.0.0.1: lo
   * consulta el healthcheck de Docker desde dentro del propio contenedor.
   */
  WORKER_HEALTH_PORT: port.default(4100),
  APP_URL: nonEmpty('APP_URL').url(),

  SMTP_HOST: z.string().optional(),
  SMTP_PORT: port.optional(),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  SMTP_FROM: mailFrom.optional(),

  S3_ENDPOINT: z.string().url().optional(),
  S3_REGION: z.string().default('us-east-1'),
  S3_BUCKET: z.string().default('nexo'),
  S3_ACCESS_KEY: z.string().optional(),
  S3_SECRET_KEY: z.string().optional(),
  S3_FORCE_PATH_STYLE: bool.default('true'),

  OPENAI_API_KEY: z.string().optional(),
  META_GRAPH_VERSION: z.string().default('v21.0'),

  SENTRY_DSN: z.string().optional(),
});

export type WorkerEnv = z.infer<typeof workerEnvSchema>;

/* ========================================================================== */

/**
 * Valida y devuelve la configuración, o aborta con un mensaje legible.
 *
 * El formato del error importa: un fallo de arranque a las 3 de la mañana
 * tiene que decir qué variable falta y cómo generarla, no volcar un objeto de
 * zod sin formatear.
 */
export function parseEnv<T extends z.ZodTypeAny>(schema: T, source: NodeJS.ProcessEnv = process.env): z.infer<T> {
  const result = schema.safeParse(source);

  if (!result.success) {
    const lines = result.error.issues.map((issue) => {
      const key = issue.path.join('.');
      return `  · ${key}: ${issue.message}`;
    });

    console.error(
      [
        '',
        'Configuración de entorno inválida. El proceso no arranca.',
        '',
        ...lines,
        '',
        'Revisa tu archivo .env contra .env.example.',
        '',
      ].join('\n'),
    );
    process.exit(1);
  }

  return result.data;
}
