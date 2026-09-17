'use client';

import type { Permission } from '@nexo/contracts';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useAccess } from '@/lib/team/use-access';
import { cn } from '@/lib/utils';

const TABS: Array<{ segment: string; label: string; permission?: Permission }> = [
  { segment: 'seguridad', label: 'Seguridad' },
  { segment: 'equipo', label: 'Equipo', permission: 'member:read' },
  { segment: 'roles', label: 'Roles', permission: 'member:read' },
];

export function SettingsNav({ slug }: { slug: string }) {
  const pathname = usePathname();
  const { can } = useAccess();

  return (
    <nav aria-label="Secciones de ajustes" className="mt-4 border-b border-border">
      <ul className="-mb-px flex gap-1">
        {TABS.filter((t) => !t.permission || can(t.permission)).map((tab) => {
          const href = `/w/${slug}/ajustes/${tab.segment}`;
          const active = pathname === href;
          return (
            <li key={tab.segment}>
              <Link
                href={href}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'inline-flex h-10 items-center border-b-2 px-3 text-sm font-medium transition-colors',
                  active
                    ? 'border-primary text-fg'
                    : 'border-transparent text-fg-muted hover:text-fg',
                )}
              >
                {tab.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
