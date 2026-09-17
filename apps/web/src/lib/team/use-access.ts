'use client';

import type { AccessView, Permission } from '@nexo/contracts';
import { useQuery } from '@tanstack/react-query';
import { useSessionStore } from '@/lib/auth/session-store';
import { teamApi } from './api';

export const accessQueryKey = (membershipId: string | undefined) => ['access', membershipId];

/**
 * Permisos EN VIVO de la sesión en su empresa.
 *
 * Deciden qué se muestra (un botón de invitar a quien no puede invitar sólo
 * frustra), no qué se permite: eso lo decide la API en cada petición.
 */
export function useAccess(): {
  access: AccessView | undefined;
  can: (permission: Permission) => boolean;
  isLoading: boolean;
} {
  const membershipId = useSessionStore((s) => s.session?.activeTenant.membershipId);
  const query = useQuery({
    queryKey: accessQueryKey(membershipId),
    queryFn: teamApi.access,
    enabled: Boolean(membershipId),
  });
  return {
    access: query.data,
    can: (permission) => Boolean(query.data?.permissions[permission]),
    isLoading: query.isLoading,
  };
}
