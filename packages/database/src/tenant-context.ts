import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Contexto que acompaña a una unidad de trabajo — una petición HTTP, un evento
 * de WebSocket o un trabajo de cola — a través de toda la pila sin tener que
 * pasarlo por parámetro en cada función.
 *
 * Es la capa 1 del aislamiento: el guard lo rellena al principio de la
 * petición y todo lo que ocurre debajo lo hereda, incluidos los trabajos que
 * se encolen desde ahí.
 */
export interface TenantContext {
  /** Empresa activa. Todo lo que se lea o escriba pertenece a ella. */
  tenantId: string;

  /** Quién actúa. Nulo en trabajos del sistema. */
  userId?: string;

  /** Membresía del usuario en esta empresa; de aquí salen sus permisos. */
  membershipId?: string;

  /**
   * Permisos efectivos ya resueltos ("contact:read", "deal:delete"…).
   * Se calculan una vez por petición y se cachean en Redis por membresía.
   */
  permissions?: ReadonlySet<string>;

  /**
   * Alcance por permiso: ALL | TEAM | OWN. Es lo que distingue a un Manager
   * que ve a su equipo de un Agente que sólo ve lo suyo.
   */
  scopes?: ReadonlyMap<string, 'ALL' | 'TEAM' | 'OWN'>;

  /** Equipo del usuario, para resolver el alcance TEAM. */
  teamName?: string | null;

  /** Naturaleza del actor: persona, clave de API, automatización, sistema. */
  actorType?: 'USER' | 'API_KEY' | 'SYSTEM' | 'AUTOMATION' | 'SUPPORT';

  /** Identificador de traza, presente en logs y en los errores que ve el usuario. */
  traceId?: string;

  ip?: string;
  userAgent?: string;

  /**
   * Suplantación de soporte activa. Cuando está presente, toda acción queda
   * marcada como realizada por soporte y el cliente recibe un aviso.
   */
  impersonation?: {
    platformAdminId: string;
    grantedByUserId: string;
    expiresAt: Date;
  };
}

const storage = new AsyncLocalStorage<TenantContext>();

/**
 * Ejecuta `fn` con el contexto dado. Todo lo de dentro lo ve.
 *
 * Cuidado con un detalle de Prisma que obliga a no usar `storage.run` a secas:
 * las consultas de Prisma son PEREZOSAS. `prisma.contact.findMany()` no ejecuta
 * nada; devuelve un objeto que sólo lanza la consulta cuando alguien llama a
 * `.then()`, es decir, cuando se hace `await`.
 *
 * Con `storage.run` a secas, esto fallaría:
 *
 *   await runWithTenantContext(ctx, () => prisma.contact.findMany());
 *
 * porque `findMany()` sale de `run` todavía sin ejecutar, y el `await` —que es
 * lo que la ejecuta— ocurre ya FUERA del contexto. La extensión de Prisma no
 * encuentra empresa y rechaza la consulta.
 *
 * Así que si `fn` devuelve algo con `.then`, se le llama aquí mismo, de forma
 * síncrona y todavía dentro del contexto. Las funciones `async` ya funcionaban
 * (su `await` interno ocurre dentro); con esto funcionan también las que
 * devuelven la consulta directamente, que es la forma más natural de escribirlo.
 */
export function runWithTenantContext<T>(context: TenantContext, fn: () => T): T {
  return storage.run(context, () => {
    const result = fn();

    if (result !== null && typeof result === 'object' && typeof (result as { then?: unknown }).then === 'function') {
      const thenable = result as unknown as PromiseLike<unknown>;
      return new Promise((resolve, reject) => thenable.then(resolve, reject)) as unknown as T;
    }

    return result;
  });
}

/** Contexto actual, o `undefined` si no hay ninguno (trabajos de plataforma). */
export function getTenantContext(): TenantContext | undefined {
  return storage.getStore();
}

/**
 * Contexto actual, o error. Úsalo donde operar sin empresa sea un fallo de
 * programación y no una posibilidad legítima.
 */
export function requireTenantContext(): TenantContext {
  const ctx = storage.getStore();
  if (!ctx) {
    throw new Error(
      'No hay contexto de empresa. Toda operación sobre datos de negocio debe ' +
        'ocurrir dentro de runWithTenantContext(). Si es una operación de ' +
        'plataforma, usa platformPrisma explícitamente.',
    );
  }
  return ctx;
}

/** Empresa activa, o error. Atajo del anterior. */
export function requireTenantId(): string {
  return requireTenantContext().tenantId;
}

/**
 * Deriva un contexto nuevo cambiando algunos campos. Se usa al encolar un
 * trabajo: hereda la empresa pero el actor pasa a ser el sistema.
 */
export function deriveContext(patch: Partial<TenantContext>): TenantContext {
  return { ...requireTenantContext(), ...patch };
}
