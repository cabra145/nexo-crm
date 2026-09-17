'use client';

import { ArrowRight, ShieldCheck, ShieldOff } from 'lucide-react';
import Link from 'next/link';
import { useSessionStore } from '@/lib/auth/session-store';

const ROLE_DESCRIPTIONS: Record<string, string> = {
  OWNER: 'Control total de la empresa, incluida la suscripción.',
  ADMIN: 'Gestionas el producto y el equipo.',
  MANAGER: 'Ves y gestionas el trabajo de tu equipo.',
  AGENT: 'Trabajas tus contactos, oportunidades y conversaciones.',
  VIEWER: 'Acceso de sólo lectura.',
};

export default function WorkspaceHome() {
  const session = useSessionStore((s) => s.session);
  if (!session) return null;

  const { user, activeTenant, memberships } = session;
  const firstName = user.name.split(' ')[0];

  return (
    <div className="mx-auto max-w-5xl px-6 py-10">
      <h1 className="text-3xl font-semibold tracking-tight">Hola, {firstName}</h1>
      <p className="mt-1 text-fg-muted">
        Estás en el espacio de{' '}
        <span className="font-medium text-fg">{activeTenant.tenantName}</span>.
      </p>

      <div className="mt-8 grid gap-4 md:grid-cols-2">
        <section className="rounded-lg border border-border bg-surface p-5">
          <h2 className="text-xs font-medium tracking-wide text-fg-faint uppercase">Tu rol</h2>
          <p className="mt-2 text-lg font-semibold">{activeTenant.roleName}</p>
          <p className="mt-1 text-sm text-fg-muted">{ROLE_DESCRIPTIONS[activeTenant.role] ?? ''}</p>
          <p className="mt-4 font-mono text-xs text-fg-faint">/w/{activeTenant.tenantSlug}</p>
        </section>

        <section className="rounded-lg border border-border bg-surface p-5">
          <h2 className="text-xs font-medium tracking-wide text-fg-faint uppercase">
            Seguridad de tu cuenta
          </h2>
          <div className="mt-2 flex items-center gap-2">
            {user.twoFactorEnabled ? (
              <ShieldCheck className="size-5 text-positive" aria-hidden />
            ) : (
              <ShieldOff className="size-5 text-fg-faint" aria-hidden />
            )}
            <p className="text-lg font-semibold">
              {user.twoFactorEnabled ? 'Verificación en dos pasos activa' : 'Sólo contraseña'}
            </p>
          </div>
          <p className="mt-1 text-sm text-fg-muted">{user.email}</p>
          <Link
            href={`/w/${activeTenant.tenantSlug}/ajustes/seguridad`}
            className="mt-4 inline-flex items-center gap-1 text-sm font-medium text-primary underline-offset-4 hover:underline"
          >
            {user.twoFactorEnabled ? 'Gestionar' : 'Activar la verificación en dos pasos'}
            <ArrowRight className="size-3.5" aria-hidden />
          </Link>
        </section>
      </div>

      {memberships.length > 1 ? (
        <section className="mt-8">
          <h2 className="text-sm font-semibold">Tus empresas</h2>
          <ul className="mt-3 divide-y divide-border overflow-hidden rounded-lg border border-border bg-surface">
            {memberships.map((m) => (
              <li key={m.tenantId}>
                <Link
                  href={`/w/${m.tenantSlug}`}
                  className="flex items-center justify-between px-4 py-3 text-sm hover:bg-surface-sunken"
                  aria-current={m.tenantId === activeTenant.tenantId ? 'page' : undefined}
                >
                  <span className="font-medium">{m.tenantName}</span>
                  <span className="text-fg-muted">{m.roleName}</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
