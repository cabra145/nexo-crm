import { ROLE_PRESETS } from '@nexo/contracts';
import type { TenantTransactionClient } from '@nexo/database';

/**
 * Todo lo que necesita una empresa recién creada para poder usarse.
 *
 * Corre dentro de `runInNewTenantTransaction`: si cualquier paso falla, no
 * queda una empresa a medias.
 */
export async function bootstrapTenant(
  tx: TenantTransactionClient,
  params: { tenantId: string; ownerUserId: string; planId: string; trialDays: number },
): Promise<{ ownerMembershipId: string }> {
  const { tenantId } = params;

  // --- Roles del sistema y sus permisos --------------------------------------
  let ownerRoleId = '';
  for (const preset of ROLE_PRESETS) {
    const role = await tx.role.create({
      data: {
        tenantId,
        key: preset.key,
        name: preset.name,
        description: preset.description,
        isSystem: true,
      },
    });
    if (preset.key === 'OWNER') ownerRoleId = role.id;
    await tx.rolePermission.createMany({
      data: Object.entries(preset.permissions).map(([permission, scope]) => ({
        tenantId,
        roleId: role.id,
        permission,
        scope,
      })),
    });
  }

  // --- Membresía del propietario ---------------------------------------------
  const membership = await tx.membership.create({
    data: {
      tenantId,
      userId: params.ownerUserId,
      roleId: ownerRoleId,
      status: 'ACTIVE',
      acceptedAt: new Date(),
    },
  });

  // --- Suscripción de prueba --------------------------------------------------
  const now = Date.now();
  const trialEnds = new Date(now + params.trialDays * 86_400_000);
  await tx.subscription.create({
    data: {
      tenantId,
      planId: params.planId,
      status: params.trialDays > 0 ? 'TRIALING' : 'ACTIVE',
      currentPeriodStart: new Date(now),
      currentPeriodEnd: trialEnds,
      trialEndsAt: params.trialDays > 0 ? trialEnds : null,
    },
  });

  // --- Embudo comercial con las siete etapas aprobadas -----------------------
  const pipeline = await tx.pipeline.create({
    data: { tenantId, name: 'Embudo comercial', isDefault: true },
  });
  const stages = [
    ['Nuevo', 'OPEN', 10, '#64748B', 7],
    ['Contactado', 'OPEN', 20, '#3B82F6', 7],
    ['Calificado', 'OPEN', 40, '#6366F1', 10],
    ['Cotización enviada', 'OPEN', 60, '#8B5CF6', 14],
    ['Negociación', 'OPEN', 80, '#F59E0B', 14],
    ['Ganado', 'WON', 100, '#10B981', null],
    ['Perdido', 'LOST', 0, '#EF4444', null],
  ] as const;
  await tx.pipelineStage.createMany({
    data: stages.map(([name, type, probability, color, rottingDays], i) => ({
      tenantId,
      pipelineId: pipeline.id,
      name,
      type,
      probability,
      color,
      rottingDays,
      position: (i + 1) * 1000,
    })),
  });

  // --- Catálogos iniciales -----------------------------------------------------
  await tx.lostReason.createMany({
    data: [
      'Precio',
      'Eligió a un competidor',
      'Sin presupuesto',
      'Mal momento',
      'Sin respuesta',
    ].map((name, sortOrder) => ({ tenantId, name, sortOrder })),
  });

  const year = new Date(now).getFullYear();
  await tx.numberSequence.createMany({
    data: (
      [
        ['QUOTE', 'COT'],
        ['PROFORMA', 'PRO'],
        ['INVOICE', 'FAC'],
      ] as const
    ).map(([kind, prefix]) => ({ tenantId, kind, prefix, series: '001', year })),
  });

  await tx.aiSetting.create({ data: { tenantId, enabled: false } });

  return { ownerMembershipId: membership.id };
}
