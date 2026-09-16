import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * Combina clases y resuelve conflictos de Tailwind: `cn('px-2', cond && 'px-4')`
 * deja sólo `px-4`. Es la utilidad que esperan los componentes de shadcn/ui.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
