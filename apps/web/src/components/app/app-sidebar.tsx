'use client';

import type { Permission } from '@nexo/contracts';
import {
  Building2,
  CheckSquare,
  Home,
  Inbox,
  KanbanSquare,
  Settings,
  Users,
  X,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { type ComponentType, useEffect } from 'react';
import { useAccess } from '@/lib/team/use-access';
import { cn } from '@/lib/utils';

interface Item {
  href: string;
  label: string;
  icon: ComponentType<{ className?: string }>;
  permission?: Permission;
  /** Marca la sección como activa también en sus subrutas. */
  prefix?: boolean;
}

const items = (slug: string): Item[] => [
  { href: `/w/${slug}`, label: 'Inicio', icon: Home },
  {
    href: `/w/${slug}/bandeja`,
    label: 'Bandeja',
    icon: Inbox,
    permission: 'conversation:read',
    prefix: true,
  },
  {
    href: `/w/${slug}/contactos`,
    label: 'Contactos',
    icon: Users,
    permission: 'contact:read',
    prefix: true,
  },
  {
    href: `/w/${slug}/empresas`,
    label: 'Empresas',
    icon: Building2,
    permission: 'company:read',
    prefix: true,
  },
  {
    href: `/w/${slug}/embudo`,
    label: 'Embudo',
    icon: KanbanSquare,
    permission: 'deal:read',
    prefix: true,
  },
  {
    href: `/w/${slug}/tareas`,
    label: 'Tareas',
    icon: CheckSquare,
    permission: 'task:read',
    prefix: true,
  },
  { href: `/w/${slug}/ajustes/seguridad`, label: 'Ajustes', icon: Settings, prefix: false },
];

/**
 * Navegación del espacio de trabajo. Fija en pantallas grandes; en móvil se
 * abre desde la cabecera y se cierra al navegar o con Escape.
 */
export function AppSidebar({
  slug,
  open,
  onClose,
}: {
  slug: string;
  open: boolean;
  onClose: () => void;
}) {
  const pathname = usePathname();

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const nav = <SidebarNav slug={slug} pathname={pathname} onNavigate={onClose} />;

  return (
    <>
      <nav
        aria-label="Secciones"
        className="hidden w-52 shrink-0 border-r border-border px-3 py-4 md:block"
      >
        {nav}
      </nav>

      {open ? (
        <div className="fixed inset-0 z-30 md:hidden">
          <button
            type="button"
            aria-label="Cerrar el menú"
            onClick={onClose}
            className="absolute inset-0 bg-fg/40"
          />
          <nav
            aria-label="Secciones"
            className="absolute inset-y-0 left-0 flex w-64 animate-slide-up flex-col border-r border-border bg-surface px-3 py-4"
          >
            <button
              type="button"
              onClick={onClose}
              aria-label="Cerrar el menú"
              className="mb-2 grid size-8 place-items-center self-end rounded-md text-fg-muted hover:bg-surface-sunken"
            >
              <X className="size-4" aria-hidden />
            </button>
            {nav}
          </nav>
        </div>
      ) : null}
    </>
  );
}

function SidebarNav({
  slug,
  pathname,
  onNavigate,
}: {
  slug: string;
  pathname: string;
  onNavigate: () => void;
}) {
  const { can } = useAccess();

  return (
    <ul className="grid gap-0.5">
      {items(slug)
        .filter((item) => !item.permission || can(item.permission))
        .map((item) => {
          const active =
            item.prefix && item.href !== `/w/${slug}`
              ? pathname.startsWith(item.href)
              : item.label === 'Ajustes'
                ? pathname.startsWith(`/w/${slug}/ajustes`)
                : pathname === item.href;
          return (
            <li key={item.href}>
              <Link
                href={item.href}
                onClick={onNavigate}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm transition-colors',
                  active
                    ? 'bg-primary-subtle font-medium text-primary'
                    : 'text-fg-muted hover:bg-surface-sunken hover:text-fg',
                )}
              >
                <item.icon className="size-4" />
                {item.label}
              </Link>
            </li>
          );
        })}
    </ul>
  );
}
