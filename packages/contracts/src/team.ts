import { z } from 'zod';
import { emailSchema, passwordSchema, uuidSchema } from './common';
import { ALL_PERMISSIONS, PERMISSIONS, type Permission, type Scope } from './permissions';

/**
 * Contrato del equipo: miembros, invitaciones y roles.
 *
 * Las reglas de «quién puede conceder qué» viven aquí y no sólo en la API: la
 * web las usa para no ofrecer lo que la API va a rechazar. La API es la que
 * las hace cumplir.
 */

export const TEAM_TIMINGS = {
  /** Vida del enlace de invitación. */
  invitationDays: 7,
} as const;

/* ========================================================================== */
/*  Permisos: agrupación y alcance                                             */
/* ========================================================================== */

/** Grupos de la matriz de permisos, en el orden en que se muestran. */
export const PERMISSION_GROUPS: ReadonlyArray<{ label: string; permissions: Permission[] }> = [
  {
    label: 'Contactos y empresas',
    permissions: [
      'contact:read',
      'contact:write',
      'contact:delete',
      'contact:export',
      'contact:import',
      'company:read',
      'company:write',
      'company:delete',
    ],
  },
  {
    label: 'Ventas',
    permissions: ['deal:read', 'deal:write', 'deal:delete', 'pipeline:manage', 'product:manage'],
  },
  {
    label: 'Conversaciones',
    permissions: [
      'conversation:read',
      'conversation:write',
      'conversation:assign',
      'channel:manage',
      'template:manage',
    ],
  },
  { label: 'Asistente de IA', permissions: ['ai:use', 'ai:manage'] },
  {
    label: 'Automatizaciones',
    permissions: ['workflow:read', 'workflow:write', 'workflow:publish'],
  },
  {
    label: 'Documentos',
    permissions: [
      'document:read',
      'document:quote',
      'document:invoice',
      'document:payment',
      'document:void',
    ],
  },
  { label: 'Agenda', permissions: ['task:read', 'task:write', 'event:read', 'event:write'] },
  { label: 'Analítica', permissions: ['dashboard:read', 'dashboard:write', 'report:export'] },
  {
    label: 'Administración',
    permissions: [
      'member:read',
      'member:invite',
      'member:manage',
      'role:manage',
      'settings:read',
      'settings:manage',
      'field:manage',
      'audit:read',
      'apikey:manage',
      'billing:manage',
    ],
  },
];

/**
 * Permisos sobre datos con dueño, en los que el alcance (toda la empresa, su
 * equipo, sólo lo suyo) tiene sentido. En el resto —configurar canales,
 * gestionar el equipo— el alcance es siempre toda la empresa.
 */
export const SCOPABLE_PERMISSIONS: ReadonlySet<Permission> = new Set<Permission>([
  'contact:read',
  'contact:write',
  'contact:delete',
  'company:read',
  'company:write',
  'company:delete',
  'deal:read',
  'deal:write',
  'deal:delete',
  'conversation:read',
  'conversation:write',
  'conversation:assign',
  'task:read',
  'task:write',
  'event:read',
  'event:write',
  'document:read',
  'document:quote',
]);

const SCOPE_RANK: Record<Scope, number> = { OWN: 1, TEAM: 2, ALL: 3 };

export type PermissionMap = Partial<Record<Permission, Scope>>;

/**
 * ¿Quien tiene `actor` puede conceder `granted`?
 *
 * Sólo si cada permiso concedido lo tiene él, con un alcance igual o mayor.
 * Es la regla contra la escalada de privilegios: nadie puede crear, asignar
 * ni editar un rol más poderoso que el suyo, ni en permisos ni en alcance.
 */
export function canGrant(actor: PermissionMap, granted: PermissionMap): boolean {
  return (Object.entries(granted) as Array<[Permission, Scope]>).every(([permission, scope]) => {
    const own = actor[permission];
    return own !== undefined && SCOPE_RANK[own] >= SCOPE_RANK[scope];
  });
}

/** Normaliza un mapa: quita permisos desconocidos y fuerza ALL donde no hay alcance. */
export function normalizePermissionMap(map: PermissionMap): PermissionMap {
  const out: PermissionMap = {};
  for (const permission of ALL_PERMISSIONS) {
    const scope = map[permission];
    if (!scope) continue;
    out[permission] = SCOPABLE_PERMISSIONS.has(permission) ? scope : 'ALL';
  }
  return out;
}

/* ========================================================================== */
/*  Peticiones                                                                 */
/* ========================================================================== */

const teamNameSchema = z
  .string()
  .trim()
  .max(80, 'como mucho 80 caracteres')
  .transform((v) => (v === '' ? null : v))
  .nullable();

export const inviteMemberSchema = z.object({
  email: emailSchema,
  roleId: uuidSchema,
  teamName: teamNameSchema.optional(),
});
export type InviteMemberInput = z.infer<typeof inviteMemberSchema>;

export const updateMemberSchema = z
  .object({
    roleId: uuidSchema.optional(),
    teamName: teamNameSchema.optional(),
  })
  .refine((v) => v.roleId !== undefined || v.teamName !== undefined, {
    message: 'indica el rol o el equipo',
    path: ['roleId'],
  });
export type UpdateMemberInput = z.infer<typeof updateMemberSchema>;

export const transferOwnershipSchema = z.object({
  membershipId: uuidSchema,
  password: z.string().min(1, 'escribe tu contraseña').max(128),
  code: z
    .string()
    .trim()
    .regex(/^\d{6}$/, 'el código tiene 6 dígitos'),
});
export type TransferOwnershipInput = z.infer<typeof transferOwnershipSchema>;

const permissionKeySchema = z.enum(ALL_PERMISSIONS as [Permission, ...Permission[]]);
const scopeSchema = z.enum(['ALL', 'TEAM', 'OWN']);

export const roleInputSchema = z.object({
  name: z.string().trim().min(2, 'escribe un nombre').max(80),
  description: z
    .string()
    .trim()
    .max(300)
    .transform((v) => (v === '' ? null : v))
    .nullable()
    .optional(),
  permissions: z
    .record(permissionKeySchema, scopeSchema)
    .refine((map) => Object.keys(map).length > 0, 'elige al menos un permiso'),
});
export type RoleInput = z.infer<typeof roleInputSchema>;

export const invitationTokenSchema = z.object({
  token: z.string().min(32).max(128),
});

export const acceptInvitationNewAccountSchema = z.object({
  token: z.string().min(32).max(128),
  name: z.string().trim().min(2, 'escribe tu nombre').max(120),
  password: passwordSchema,
});
export type AcceptInvitationNewAccountInput = z.infer<typeof acceptInvitationNewAccountSchema>;

/* ========================================================================== */
/*  Respuestas                                                                 */
/* ========================================================================== */

export type RoleKey = 'OWNER' | 'ADMIN' | 'MANAGER' | 'AGENT' | 'VIEWER' | 'CUSTOM';
export type MemberStatus = 'INVITED' | 'ACTIVE' | 'DISABLED';

/** Lo que puede hacer la sesión actual en su empresa, resuelto en vivo. */
export interface AccessView {
  membershipId: string;
  userId: string;
  role: { id: string; key: RoleKey; name: string };
  teamName: string | null;
  permissions: PermissionMap;
}

export interface MemberView {
  membershipId: string;
  userId: string;
  name: string;
  email: string;
  status: MemberStatus;
  role: { id: string; key: RoleKey; name: string };
  teamName: string | null;
  twoFactorEnabled: boolean;
  invitedAt: string;
  acceptedAt: string | null;
  lastLoginAt: string | null;
  /** Invitación pendiente: cuándo caduca el último enlace enviado. */
  invitationExpiresAt: string | null;
}

export interface TeamView {
  members: MemberView[];
  /** Plazas ocupadas (activos, desactivados no cuentan; invitaciones pendientes sí). */
  seats: { used: number; limit: number | null };
}

export interface RoleView {
  id: string;
  key: RoleKey;
  name: string;
  description: string | null;
  isSystem: boolean;
  memberCount: number;
  permissions: PermissionMap;
}

export interface RolesView {
  roles: RoleView[];
  /** El plan permite roles personalizados. */
  customRolesEnabled: boolean;
}

export interface InvitationPreview {
  email: string;
  tenantName: string;
  roleName: string;
  inviterName: string | null;
  /** El correo ya tiene cuenta: se acepta iniciando sesión, no creando una. */
  accountExists: boolean;
  expiresAt: string;
}

export interface InvitationAccepted {
  tenantId: string;
  tenantSlug: string;
}

/** Códigos de error del equipo, en `ApiProblem.type`. */
export const TEAM_PROBLEMS = {
  SEAT_LIMIT: 'https://nexo.app/problems/limite-de-usuarios',
  ESCALATION: 'https://nexo.app/problems/escalada-de-privilegios',
  OWNER_PROTECTED: 'https://nexo.app/problems/propietario-protegido',
  SELF_CHANGE: 'https://nexo.app/problems/cambio-propio',
  ALREADY_MEMBER: 'https://nexo.app/problems/ya-es-miembro',
  INVITATION_EMAIL_MISMATCH: 'https://nexo.app/problems/invitacion-de-otra-cuenta',
  FEATURE_UNAVAILABLE: 'https://nexo.app/problems/funcion-no-incluida',
  MEMBERSHIP_INACTIVE: 'https://nexo.app/problems/sin-acceso-a-la-empresa',
} as const;

/*
 * Todo permiso tiene que estar en exactamente un grupo: uno sin grupo no
 * aparecería en la matriz de roles y no se podría conceder. Se comprueba al
 * cargar el módulo, así que un permiso nuevo sin agrupar rompe la API, la web
 * y el CI desde el primer arranque.
 */
{
  const grouped = PERMISSION_GROUPS.flatMap((g) => g.permissions);
  const missing = ALL_PERMISSIONS.filter((p) => !grouped.includes(p));
  const repeated = grouped.filter((p, i) => grouped.indexOf(p) !== i);
  if (missing.length > 0 || repeated.length > 0 || grouped.some((p) => !(p in PERMISSIONS))) {
    throw new Error(
      `PERMISSION_GROUPS no cubre el catálogo: sin grupo [${missing.join(', ')}], repetidos [${repeated.join(', ')}]`,
    );
  }
}
