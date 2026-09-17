'use client';

import type { SessionResponse } from '@nexo/contracts';
import { BRAND } from '@nexo/design/brand';
import { ChevronsUpDown, LogOut, Menu, ShieldCheck, Users } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { ThemeToggle } from '@/components/theme-toggle';
import { logout } from '@/lib/auth/session';
import { cn } from '@/lib/utils';

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join('');
}

export function AppHeader({
  session,
  onOpenMenu,
}: {
  session: SessionResponse;
  /** Ausente cuando no hay nada que navegar (2FA vencido). */
  onOpenMenu?: () => void;
}) {
  const router = useRouter();
  const { user, activeTenant, memberships } = session;
  const slug = activeTenant.tenantSlug;

  return (
    <header className="sticky top-0 z-20 border-b border-border bg-surface/85 backdrop-blur">
      <div className="flex h-14 items-center gap-3 px-4 sm:px-6">
        {onOpenMenu ? (
          <button
            type="button"
            onClick={onOpenMenu}
            aria-label="Abrir el menú"
            className="-ml-1 grid size-8 place-items-center rounded-md text-fg-muted hover:bg-surface-sunken hover:text-fg md:hidden"
          >
            <Menu className="size-5" aria-hidden />
          </button>
        ) : null}
        <Link
          href={`/w/${slug}`}
          className="flex items-center gap-2 rounded-md"
          aria-label={`${BRAND.fullName}, inicio`}
        >
          <span
            aria-hidden
            className="grid size-7 place-items-center rounded-md bg-primary text-xs font-semibold text-fg-on-primary"
          >
            {BRAND.name.charAt(0)}
          </span>
        </Link>

        <span className="text-border-strong" aria-hidden>
          /
        </span>

        {memberships.length > 1 ? (
          <label className="relative flex items-center">
            <span className="sr-only">Empresa activa</span>
            <select
              value={slug}
              onChange={(e) => router.push(`/w/${e.target.value}`)}
              className="h-8 appearance-none rounded-md bg-transparent py-0 pr-7 pl-2 text-sm font-medium hover:bg-surface-sunken focus-visible:outline-2"
            >
              {memberships.map((m) => (
                <option key={m.tenantId} value={m.tenantSlug}>
                  {m.tenantName}
                </option>
              ))}
            </select>
            <ChevronsUpDown
              className="pointer-events-none absolute right-2 size-3.5 text-fg-faint"
              aria-hidden
            />
          </label>
        ) : (
          <span className="text-sm font-medium">{activeTenant.tenantName}</span>
        )}

        <div className="ml-auto flex items-center gap-2">
          <ThemeToggle />
          <UserMenu name={user.name} email={user.email} slug={slug} />
        </div>
      </div>
    </header>
  );
}

function UserMenu({ name, email, slug }: { name: string; email: string; slug: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Menú de ${name}`}
        className="grid size-8 place-items-center rounded-full bg-primary-subtle text-xs font-semibold text-primary hover:ring-2 hover:ring-border"
      >
        {initials(name)}
      </button>

      {open ? (
        <div
          role="menu"
          className="absolute right-0 mt-2 w-64 animate-slide-up overflow-hidden rounded-lg border border-border bg-surface-raised shadow-overlay"
        >
          <div className="border-b border-border px-3 py-2.5">
            <p className="truncate text-sm font-medium">{name}</p>
            <p className="truncate text-xs text-fg-muted">{email}</p>
          </div>
          <div className="p-1">
            <MenuItem href={`/w/${slug}/ajustes/seguridad`} onSelect={() => setOpen(false)}>
              <ShieldCheck aria-hidden />
              Seguridad
            </MenuItem>
            <MenuItem href={`/w/${slug}/ajustes/equipo`} onSelect={() => setOpen(false)}>
              <Users aria-hidden />
              Equipo
            </MenuItem>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                void logout().finally(() => router.replace('/login'));
              }}
              className={itemClass}
            >
              <LogOut aria-hidden />
              Cerrar sesión
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

const itemClass = cn(
  'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-fg-muted',
  'hover:bg-surface-sunken hover:text-fg [&_svg]:size-4',
);

function MenuItem({
  href,
  onSelect,
  children,
}: {
  href: string;
  onSelect: () => void;
  children: React.ReactNode;
}) {
  return (
    <Link href={href} role="menuitem" onClick={onSelect} className={itemClass}>
      {children}
    </Link>
  );
}
