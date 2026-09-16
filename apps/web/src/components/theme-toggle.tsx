'use client';

import { Monitor, Moon, Sun } from 'lucide-react';
import { useTheme } from 'next-themes';
import { useSyncExternalStore } from 'react';
import { cn } from '@/lib/utils';

const subscribeNoop = () => () => {};

const OPTIONS = [
  { value: 'light', label: 'Claro', icon: Sun },
  { value: 'dark', label: 'Oscuro', icon: Moon },
  { value: 'system', label: 'Sistema', icon: Monitor },
] as const;

/**
 * Selector de tema: claro, oscuro o el del sistema.
 *
 * Es un grupo de opciones (radiogroup) y no un botón que alterna, porque
 * "Sistema" es un tercer estado real que el usuario tiene que poder ver y
 * elegir, no algo implícito.
 */
export function ThemeToggle({ className }: { className?: string }) {
  const { theme, setTheme } = useTheme();

  // El tema elegido se lee del navegador, así que en el servidor no se conoce.
  // En el servidor (y en la hidratación) se pinta sin selección; en el cliente,
  // con la real. `useSyncExternalStore` hace exactamente esa distinción sin el
  // truco de `useEffect(() => setMounted(true))`, que obliga a renderizar dos
  // veces.
  const mounted = useSyncExternalStore(
    subscribeNoop,
    () => true,
    () => false,
  );

  return (
    <div
      role="radiogroup"
      aria-label="Tema de la interfaz"
      className={cn(
        'inline-flex items-center gap-0.5 rounded-md border border-border bg-surface p-0.5',
        className,
      )}
    >
      {OPTIONS.map(({ value, label, icon: Icon }) => {
        const selected = mounted && theme === value;
        return (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={label}
            title={label}
            onClick={() => setTheme(value)}
            className={cn(
              'inline-flex size-6 items-center justify-center rounded-sm transition-colors duration-150',
              selected ? 'bg-surface-sunken text-fg' : 'text-fg-faint hover:text-fg-muted',
            )}
          >
            <Icon className="size-3.5" aria-hidden />
          </button>
        );
      })}
    </div>
  );
}
