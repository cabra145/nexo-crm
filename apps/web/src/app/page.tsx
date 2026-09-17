'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { refreshSession } from '@/lib/auth/session';

/**
 * Raíz: al espacio de trabajo si hay sesión, al inicio de sesión si no.
 *
 * La comprobación se hace en el navegador: la sesión vive en una cookie del
 * dominio de la API, que el servidor de la web no ve.
 */
export default function Home() {
  const router = useRouter();

  useEffect(() => {
    void refreshSession()
      .then((session) =>
        router.replace(session ? `/w/${session.activeTenant.tenantSlug}` : '/login'),
      )
      .catch(() => router.replace('/login'));
  }, [router]);

  return <div className="min-h-dvh bg-canvas" aria-busy="true" aria-label="Cargando" />;
}
