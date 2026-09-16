import { z } from 'zod';

/**
 * Convenciones compartidas por toda la API.
 *
 * Estos esquemas los usan LITERALMENTE los dos lados: el DTO del controlador
 * en NestJS y el formulario en el navegador. Una sola fuente de verdad, así
 * que una regla de validación no puede divergir entre cliente y servidor.
 */

/* ========================================================================== */
/*  Paginación por cursor                                                     */
/* ----------------------------------------------------------------------------
 *  Por cursor y no por página: los listados crecen y `OFFSET 50000` obliga a
 *  Postgres a recorrer y descartar 50 000 filas en cada consulta. Con cursor,
 *  la página 1000 cuesta lo mismo que la primera.
 * ========================================================================== */

export const cursorPaginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  /** Id del último elemento de la página anterior. */
  cursor: z.string().uuid().optional(),
});

export type CursorPagination = z.infer<typeof cursorPaginationSchema>;

export interface Paginated<T> {
  data: T[];
  nextCursor: string | null;
  hasMore: boolean;
  /** Presente sólo si se pidió expresamente: contar es caro. */
  total?: number;
}

/**
 * Construye la respuesta paginada.
 *
 * Se pide siempre UN elemento de más para saber si hay página siguiente sin
 * tener que contar el total.
 */
export function paginate<T extends { id: string }>(rows: T[], limit: number): Paginated<T> {
  const hasMore = rows.length > limit;
  const data = hasMore ? rows.slice(0, limit) : rows;

  return {
    data,
    hasMore,
    nextCursor: hasMore ? (data[data.length - 1]?.id ?? null) : null,
  };
}

/* ========================================================================== */
/*  Orden                                                                      */
/* ========================================================================== */

export const sortSchema = z.object({
  sortBy: z.string().optional(),
  sortDir: z.enum(['asc', 'desc']).default('desc'),
});

/**
 * Traduce el orden pedido, comprobándolo contra una lista blanca.
 *
 * Nunca se pasa un nombre de columna del usuario directamente a la consulta:
 * `allowed` es la única puerta.
 */
export function resolveSort<T extends string>(
  input: { sortBy?: string; sortDir?: 'asc' | 'desc' },
  allowed: readonly T[],
  fallback: T,
): Record<string, 'asc' | 'desc'> {
  const field = allowed.includes(input.sortBy as T) ? (input.sortBy as T) : fallback;
  return { [field]: input.sortDir ?? 'desc' };
}

/* ========================================================================== */
/*  Errores — RFC 7807 con extras                                             */
/* ========================================================================== */

export interface ApiProblem {
  /** URI que identifica el tipo de problema. */
  type: string;
  /** Resumen legible, estable entre ocurrencias. */
  title: string;
  status: number;
  /** Detalle de ESTA ocurrencia. */
  detail?: string;
  /**
   * Identificador de traza. Se muestra en la interfaz para que soporte pueda
   * encontrar la traza exacta sin pedirle capturas al usuario.
   */
  traceId?: string;
  /** Errores por campo, para pintarlos junto a cada input. */
  errors?: Array<{ field: string; message: string }>;
}

export const PROBLEM_TYPES = {
  VALIDATION: 'https://nexo.app/problems/validacion',
  UNAUTHORIZED: 'https://nexo.app/problems/no-autenticado',
  FORBIDDEN: 'https://nexo.app/problems/sin-permiso',
  NOT_FOUND: 'https://nexo.app/problems/no-encontrado',
  CONFLICT: 'https://nexo.app/problems/conflicto',
  RATE_LIMITED: 'https://nexo.app/problems/demasiadas-peticiones',
  QUOTA_EXCEEDED: 'https://nexo.app/problems/limite-de-plan',
  INTERNAL: 'https://nexo.app/problems/error-interno',
} as const;

/* ========================================================================== */
/*  Tipos primitivos reutilizados                                             */
/* ========================================================================== */

export const uuidSchema = z.string().uuid('identificador inválido');

/**
 * Teléfono en E.164.
 *
 * Esta invariante NO es cosmética: de ella dependen la deduplicación de la
 * importación y el emparejamiento de un WhatsApp entrante con su contacto.
 * Por eso la valida el esquema, la valida el servicio y la valida una
 * restricción CHECK en la base.
 */
export const phoneE164Schema = z
  .string()
  .regex(
    /^\+[1-9]\d{6,14}$/,
    'el teléfono debe estar en formato internacional, p. ej. +593987654321',
  );

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .email('correo electrónico inválido')
  .max(255);

/**
 * Contraseña.
 *
 * Longitud por encima de reglas de composición barrocas: "Contraseña-larga-y-
 * memorable" es más fuerte que "P@ss1!" y la gente no la apunta en un papel.
 * Se exige variedad mínima, pero el peso está en los 12 caracteres.
 */
export const passwordSchema = z
  .string()
  .min(12, 'mínimo 12 caracteres')
  .max(128, 'máximo 128 caracteres')
  .refine((v) => /[a-z]/.test(v) && /[A-Z]/.test(v) && /\d/.test(v), {
    message: 'debe combinar mayúsculas, minúsculas y al menos un número',
  });

export const slugSchema = z
  .string()
  .min(3, 'mínimo 3 caracteres')
  .max(63, 'máximo 63 caracteres')
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'sólo minúsculas, números y guiones')
  .refine((v) => !RESERVED_SLUGS.has(v), { message: 'ese nombre está reservado' });

/** Rutas que no pueden ser el identificador de una empresa. */
export const RESERVED_SLUGS = new Set([
  'admin',
  'api',
  'app',
  'www',
  'mail',
  'ftp',
  'login',
  'logout',
  'register',
  'registro',
  'auth',
  'static',
  'assets',
  'public',
  'health',
  'status',
  'docs',
  'help',
  'support',
  'soporte',
  'blog',
  'about',
  'pricing',
  'precios',
  'legal',
  'privacy',
  'terms',
  'w',
  'workspace',
  'settings',
  'ajustes',
  'billing',
  'nexo',
  'system',
  'root',
  'test',
  'dev',
  'staging',
]);

export const isoDateSchema = z.coerce.date();

export const moneySchema = z.coerce
  .number()
  .min(0, 'no puede ser negativo')
  .max(999_999_999.99)
  .transform((v) => Math.round(v * 100) / 100);

export const currencySchema = z
  .string()
  .length(3)
  .toUpperCase()
  .regex(/^[A-Z]{3}$/, 'código de moneda ISO 4217, p. ej. USD');

export const countrySchema = z
  .string()
  .length(2)
  .toUpperCase()
  .regex(/^[A-Z]{2}$/, 'código de país ISO 3166-1, p. ej. EC');

/* ========================================================================== */
/*  Filtros                                                                    */
/* ========================================================================== */

/**
 * Operadores admitidos en `?filter[campo][op]=valor`.
 *
 * Deliberadamente cortos y cerrados: cada uno se traduce a su equivalente de
 * Prisma por un constructor con lista blanca de campos. El usuario nunca
 * escribe SQL ni nombres de columna libres.
 */
export const FILTER_OPERATORS = [
  'eq',
  'ne',
  'gt',
  'gte',
  'lt',
  'lte',
  'in',
  'contains',
  'null',
] as const;
export type FilterOperator = (typeof FILTER_OPERATORS)[number];

export const searchSchema = z.object({
  q: z.string().trim().max(200).optional(),
});
