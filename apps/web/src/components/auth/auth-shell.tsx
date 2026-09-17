import { BRAND } from '@nexo/design/brand';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { ThemeToggle } from '@/components/theme-toggle';

/**
 * Marco de las pantallas de autenticación: una columna estrecha y tranquila,
 * sin nada que distraiga de la tarea (entrar, registrarse, recuperar acceso).
 */
export function AuthShell({
  title,
  description,
  children,
  footer,
}: {
  title: string;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <div className="relative flex min-h-dvh flex-col bg-canvas">
      {/* Halo muy sutil detrás del formulario: da profundidad sin competir con él. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-[28rem] bg-[radial-gradient(ellipse_at_top,var(--color-primary-subtle),transparent_70%)] opacity-70"
      />

      <header className="relative flex h-16 items-center justify-between px-6">
        <Link
          href="/"
          className="flex items-center gap-2 rounded-md"
          aria-label={`${BRAND.fullName}, inicio`}
        >
          <span
            aria-hidden
            className="grid size-7 place-items-center rounded-md bg-primary text-xs font-semibold text-fg-on-primary"
          >
            {BRAND.name.charAt(0)}
          </span>
          <span className="text-sm font-semibold tracking-tight">{BRAND.fullName}</span>
        </Link>
        <ThemeToggle />
      </header>

      <main className="relative flex flex-1 items-start justify-center px-6 pt-[8vh] pb-16">
        <div className="w-full max-w-[25rem] animate-slide-up">
          <div className="mb-8 space-y-2">
            <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
            {description ? <div className="text-fg-muted">{description}</div> : null}
          </div>
          {children}
          {footer ? <div className="mt-8 text-center text-sm text-fg-muted">{footer}</div> : null}
        </div>
      </main>
    </div>
  );
}
