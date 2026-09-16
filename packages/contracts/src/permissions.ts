/**
 * Catálogo de permisos y roles del sistema.
 *
 * Fuente única: la API los aplica, la web los usa para decidir qué mostrar y
 * el seed construye los roles con ellos. Un permiso que no esté aquí no
 * existe — el tipo `Permission` lo impide en compilación.
 */

/* ============================================================================
 *  Permisos
 * ----------------------------------------------------------------------------
 *  Formato `recurso:acción`. Granulares a propósito: los roles son
 *  agrupaciones de estos, y un plan alto permite a la empresa definir los
 *  suyos combinándolos como quiera.
 * ========================================================================== */

export const PERMISSIONS = {
  // --- CRM ---------------------------------------------------------------
  'contact:read': 'Ver contactos',
  'contact:write': 'Crear y editar contactos',
  'contact:delete': 'Eliminar contactos',
  'contact:export': 'Exportar contactos',
  'contact:import': 'Importar contactos',

  'company:read': 'Ver empresas',
  'company:write': 'Crear y editar empresas',
  'company:delete': 'Eliminar empresas',

  // --- Ventas ------------------------------------------------------------
  'deal:read': 'Ver oportunidades',
  'deal:write': 'Crear y editar oportunidades',
  'deal:delete': 'Eliminar oportunidades',
  'pipeline:manage': 'Configurar embudos y etapas',
  'product:manage': 'Gestionar productos y precios',

  // --- Conversaciones ----------------------------------------------------
  'conversation:read': 'Ver conversaciones',
  'conversation:write': 'Responder conversaciones',
  'conversation:assign': 'Asignar conversaciones',
  'channel:manage': 'Configurar canales de mensajería',
  'template:manage': 'Gestionar plantillas de mensaje',

  // --- IA ----------------------------------------------------------------
  'ai:use': 'Usar el asistente',
  'ai:manage': 'Configurar la IA y su base de conocimiento',

  // --- Automatizaciones --------------------------------------------------
  'workflow:read': 'Ver automatizaciones',
  'workflow:write': 'Crear y editar automatizaciones',
  'workflow:publish': 'Publicar automatizaciones',

  // --- Documentos --------------------------------------------------------
  'document:read': 'Ver documentos',
  'document:quote': 'Crear cotizaciones y proformas',
  'document:invoice': 'Emitir facturas',
  'document:payment': 'Registrar pagos',
  'document:void': 'Anular documentos',

  // --- Agenda ------------------------------------------------------------
  'task:read': 'Ver tareas',
  'task:write': 'Crear y editar tareas',
  'event:read': 'Ver el calendario',
  'event:write': 'Crear y editar eventos',

  // --- Analítica ---------------------------------------------------------
  'dashboard:read': 'Ver paneles',
  'dashboard:write': 'Crear y editar paneles',
  'report:export': 'Exportar informes',

  // --- Administración de la empresa --------------------------------------
  'member:read': 'Ver el equipo',
  'member:invite': 'Invitar usuarios',
  'member:manage': 'Gestionar usuarios y roles',
  'role:manage': 'Crear y editar roles',
  'settings:read': 'Ver la configuración',
  'settings:manage': 'Cambiar la configuración',
  'field:manage': 'Gestionar campos personalizados',
  'audit:read': 'Ver el registro de auditoría',
  'apikey:manage': 'Gestionar claves de API y webhooks',
  'billing:manage': 'Gestionar el plan y la suscripción',
} as const;

export type Permission = keyof typeof PERMISSIONS;

export const ALL_PERMISSIONS = Object.keys(PERMISSIONS) as Permission[];

/* ============================================================================
 *  Alcance
 * ----------------------------------------------------------------------------
 *  Un permiso responde a "¿puede tocar esta CLASE de recurso?".
 *  El alcance responde a "¿sobre qué FILAS?".
 *
 *  Es la distinción que hace que un Manager vea a su equipo y un Agente sólo
 *  lo suyo, con el mismo permiso `contact:read`.
 * ========================================================================== */

export type Scope = 'ALL' | 'TEAM' | 'OWN';

export const SCOPE_LABELS: Record<Scope, string> = {
  ALL: 'Toda la empresa',
  TEAM: 'Su equipo',
  OWN: 'Sólo los suyos',
};

/* ============================================================================
 *  Roles del sistema
 * ----------------------------------------------------------------------------
 *  Se crean con cada empresa nueva y no son editables (`isSystem`). Reflejan
 *  exactamente la matriz aprobada en el documento de arquitectura, §06.
 * ========================================================================== */

export type SystemRoleKey = 'OWNER' | 'ADMIN' | 'MANAGER' | 'AGENT' | 'VIEWER';

export interface RolePreset {
  key: SystemRoleKey;
  name: string;
  description: string;
  /** Permiso → alcance. Un permiso ausente significa denegado. */
  permissions: Partial<Record<Permission, Scope>>;
}

/** Construye un mapa permiso→alcance a partir de una lista, con alcance común. */
function grant(scope: Scope, permissions: Permission[]): Partial<Record<Permission, Scope>> {
  return Object.fromEntries(permissions.map((p) => [p, scope]));
}

const AGENT_PERMISSIONS: Permission[] = [
  'contact:read',
  'contact:write',
  'company:read',
  'deal:read',
  'deal:write',
  'conversation:read',
  'conversation:write',
  'ai:use',
  'task:read',
  'task:write',
  'event:read',
  'event:write',
  'document:read',
  'dashboard:read',
  'member:read',
  'settings:read',
];

const MANAGER_EXTRA: Permission[] = [
  'contact:delete',
  'company:write',
  'company:delete',
  'deal:delete',
  'conversation:assign',
  'workflow:read',
  'workflow:write',
  'document:quote',
  'dashboard:write',
  'report:export',
];

const ADMIN_EXTRA: Permission[] = [
  'contact:export',
  'contact:import',
  'pipeline:manage',
  'product:manage',
  'channel:manage',
  'template:manage',
  'ai:manage',
  'workflow:publish',
  'document:invoice',
  'document:payment',
  'document:void',
  'member:invite',
  'member:manage',
  'role:manage',
  'settings:manage',
  'field:manage',
  'audit:read',
  'apikey:manage',
];

export const ROLE_PRESETS: RolePreset[] = [
  {
    key: 'OWNER',
    name: 'Propietario',
    description:
      'Control total, incluida la suscripción y el cierre de la cuenta. Requiere segundo factor.',
    // Todo, sobre toda la empresa.
    permissions: grant('ALL', ALL_PERMISSIONS),
  },
  {
    key: 'ADMIN',
    name: 'Administrador',
    description:
      'Gestiona el producto entero y al equipo. No puede tocar el plan ni la facturación del SaaS.',
    permissions: grant('ALL', [...AGENT_PERMISSIONS, ...MANAGER_EXTRA, ...ADMIN_EXTRA]),
  },
  {
    key: 'MANAGER',
    name: 'Responsable de equipo',
    description:
      'Ve y gestiona el trabajo de su equipo. Puede cotizar, pero no facturar ni cambiar ajustes.',
    permissions: {
      // Los datos de negocio, limitados a su equipo.
      ...grant('TEAM', [
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
      ]),
      // Lo transversal, sobre toda la empresa.
      ...grant('ALL', [
        'ai:use',
        'workflow:read',
        'workflow:write',
        'dashboard:read',
        'dashboard:write',
        'report:export',
        'member:read',
        'settings:read',
      ]),
    },
  },
  {
    key: 'AGENT',
    name: 'Agente',
    description: 'Trabaja sus propios contactos y oportunidades, y atiende conversaciones.',
    permissions: {
      ...grant('OWN', [
        'contact:read',
        'contact:write',
        'deal:read',
        'deal:write',
        'task:read',
        'task:write',
        'event:read',
        'event:write',
        'document:read',
      ]),
      ...grant('ALL', [
        'company:read',
        // Las conversaciones se reparten por asignación, no por propiedad:
        // un agente tiene que poder coger una sin dueño.
        'conversation:read',
        'conversation:write',
        'ai:use',
        'dashboard:read',
        'member:read',
        'settings:read',
      ]),
    },
  },
  {
    key: 'VIEWER',
    name: 'Invitado',
    description: 'Sólo lectura. Para dirección, contabilidad o auditoría externa.',
    permissions: grant('ALL', [
      'contact:read',
      'company:read',
      'deal:read',
      'document:read',
      'task:read',
      'event:read',
      'dashboard:read',
      'member:read',
    ]),
  },
];

export const ROLE_PRESETS_BY_KEY = Object.fromEntries(
  ROLE_PRESETS.map((preset) => [preset.key, preset]),
) as Record<SystemRoleKey, RolePreset>;

/* ============================================================================
 *  Ayudas de comprobación
 * ========================================================================== */

/** ¿El conjunto de permisos incluye éste? */
export function hasPermission(
  permissions: ReadonlySet<string> | undefined,
  permission: Permission,
): boolean {
  return permissions?.has(permission) ?? false;
}

/**
 * Filtro de fila que corresponde a un alcance.
 *
 * Devuelve el fragmento de `where` que hay que añadir; `null` significa "sin
 * restricción". Los servicios lo aplican sobre sus consultas: el permiso ya se
 * comprobó en el controlador, esto acota QUÉ filas.
 */
export function scopeFilter(
  scope: Scope,
  actor: { userId?: string; teamMemberIds?: string[] },
  ownerField = 'ownerId',
): Record<string, unknown> | null {
  switch (scope) {
    case 'ALL':
      return null;
    case 'TEAM':
      return { [ownerField]: { in: actor.teamMemberIds ?? [] } };
    case 'OWN':
      return { [ownerField]: actor.userId ?? '__sin_usuario__' };
  }
}
