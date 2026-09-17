import type { TenantTransactionClient } from '@nexo/database';

export interface PlanLimits {
  /** Usuarios incluidos (activos + invitaciones pendientes). Null = sin límite. */
  maxUsers: number | null;
  /** Contactos incluidos. Null = sin límite. */
  maxContacts: number | null;
  customRoles: boolean;
}

/**
 * Límites efectivos de la empresa del contexto: los del plan, con los
 * `limitOverrides` de su suscripción por encima (acuerdos a medida).
 *
 * Sin suscripción no hay plan que limite: sólo pasa en empresas creadas a
 * mano. El registro siempre crea una.
 */
export async function loadPlanLimits(tx: TenantTransactionClient): Promise<PlanLimits> {
  const subscription = await tx.subscription.findFirst({
    select: {
      limitOverrides: true,
      plan: {
        select: {
          maxUsers: true,
          maxContacts: true,
          features: { where: { key: 'custom_roles' }, select: { enabled: true } },
        },
      },
    },
  });
  if (!subscription) return { maxUsers: null, maxContacts: null, customRoles: false };

  const overrides = (subscription.limitOverrides ?? {}) as {
    maxUsers?: unknown;
    maxContacts?: unknown;
  };
  const maxUsers =
    typeof overrides.maxUsers === 'number' ? overrides.maxUsers : subscription.plan.maxUsers;
  const maxContacts =
    typeof overrides.maxContacts === 'number'
      ? overrides.maxContacts
      : subscription.plan.maxContacts;

  return {
    maxUsers: maxUsers < 0 ? null : maxUsers,
    maxContacts: maxContacts < 0 ? null : maxContacts,
    customRoles: subscription.plan.features.some((f) => f.enabled),
  };
}

/**
 * Serializa los cambios de equipo de una empresa dentro de la transacción.
 *
 * Sin esto, dos invitaciones simultáneas leerían el mismo recuento de plazas y
 * las dos cabrían; o dos transferencias de propiedad se cruzarían. El bloqueo
 * es de Postgres, por empresa, y se libera solo al terminar la transacción.
 */
export async function lockTeam(tx: TenantTransactionClient, tenantId: string): Promise<void> {
  await lockResource(tx, `nexo:team:${tenantId}`);
}

/** Bloqueo por recurso dentro de la transacción. Se libera al terminarla. */
export async function lockResource(tx: TenantTransactionClient, key: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
}
