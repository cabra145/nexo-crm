'use client';

import { usePathname, useRouter } from 'next/navigation';
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { authApi } from '@/lib/auth/api';
import { applySession, refreshSession } from '@/lib/auth/session';
import { useSessionStore } from '@/lib/auth/session-store';
import { AppHeader } from './app-header';
import { TwoFactorBanner, TwoFactorBlocked } from './two-factor-notices';

/**
 * Puerta del espacio de trabajo `/w/[empresa]`.
 *
 * 1. Sin sesión en memoria (recarga, pestaña nueva), la recupera con la cookie
 *    de refresco. Si no hay, lleva al inicio de sesión y vuelve aquí después.
 * 2. Si la empresa de la URL no es la de la sesión, cambia de empresa (si el
 *    usuario pertenece a ella) o corrige la URL.
 * 3. Si el plazo del 2FA obligatorio venció, sólo deja entrar a Seguridad.
 *
 * La protección REAL está en la API: sin token válido no devuelve datos. Esto
 * decide qué pantalla mostrar, no qué datos son accesibles.
 */
export function SessionGate({ slug, children }: { slug: string; children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const { status, session } = useSessionStore();
  const switching = useRef(false);
  // La API no respondió (caída, red): se dice, en vez de cargar para siempre.
  const [unreachable, setUnreachable] = useState(false);

  const bootstrap = useCallback(() => {
    setUnreachable(false);
    refreshSession().catch(() => setUnreachable(true));
  }, []);

  useEffect(() => {
    if (status === 'unknown') {
      refreshSession().catch(() => setUnreachable(true));
    } else if (status === 'anonymous') {
      router.replace(`/login?next=${encodeURIComponent(pathname)}`);
    }
  }, [status, pathname, router]);

  const activeSlug = session?.activeTenant.tenantSlug;

  useEffect(() => {
    if (!session || activeSlug === slug || switching.current) return;
    const target = session.memberships.find((m) => m.tenantSlug === slug);
    if (!target) {
      router.replace(`/w/${activeSlug}`);
      return;
    }
    switching.current = true;
    authApi
      .switchTenant(target.tenantId)
      .then(applySession)
      .catch(() => router.replace(`/w/${activeSlug}`))
      .finally(() => {
        switching.current = false;
      });
  }, [session, activeSlug, slug, router]);

  if (unreachable && status === 'unknown') {
    return (
      <div className="grid min-h-dvh place-items-center px-6">
        <Alert tone="critical" title="No podemos conectar con Nexo" className="max-w-md">
          <p>Revisa tu conexión. Si todo está bien, el servicio puede estar reiniciándose.</p>
          <Button size="sm" variant="secondary" className="mt-3" onClick={bootstrap}>
            Reintentar
          </Button>
        </Alert>
      </div>
    );
  }

  if (status !== 'authenticated' || !session || activeSlug !== slug) {
    return (
      <div
        className="flex min-h-dvh flex-col"
        aria-busy="true"
        aria-label="Cargando tu espacio de trabajo"
      >
        <div className="h-14 border-b border-border" />
        <div className="mx-auto w-full max-w-5xl space-y-4 px-6 py-10">
          <div className="h-8 w-64 animate-pulse rounded bg-surface-sunken" />
          <div className="h-32 animate-pulse rounded-lg bg-surface-sunken" />
        </div>
      </div>
    );
  }

  const onSecurityPage = pathname.endsWith('/ajustes/seguridad');
  const { twoFactor } = session;

  return (
    <div className="flex min-h-dvh flex-col">
      <AppHeader session={session} />
      {twoFactor.blocked && !onSecurityPage ? (
        <TwoFactorBlocked slug={slug} />
      ) : (
        <>
          {twoFactor.required && !twoFactor.enabled && !onSecurityPage ? (
            <TwoFactorBanner slug={slug} deadline={twoFactor.deadline} />
          ) : null}
          <main className="min-w-0 flex-1">{children}</main>
        </>
      )}
    </div>
  );
}
