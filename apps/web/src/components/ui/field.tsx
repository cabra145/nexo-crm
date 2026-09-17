import { useId, type ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { Label } from './label';

/**
 * Etiqueta + control + ayuda + error, conectados por accesibilidad: el lector
 * de pantalla anuncia el error y la ayuda al entrar en el campo.
 */
export function Field({
  label,
  hint,
  error,
  aside,
  className,
  children,
}: {
  label: string;
  hint?: ReactNode;
  error?: string;
  /** Contenido a la derecha de la etiqueta, p. ej. "¿La olvidaste?" */
  aside?: ReactNode;
  className?: string;
  children: (props: {
    id: string;
    'aria-invalid'?: true;
    'aria-describedby'?: string;
  }) => ReactNode;
}) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [errorId, hintId].filter(Boolean).join(' ') || undefined;

  return (
    <div className={cn('grid gap-1.5', className)}>
      <div className="flex items-baseline justify-between gap-3">
        <Label htmlFor={id}>{label}</Label>
        {aside}
      </div>
      {children({ id, 'aria-invalid': error ? true : undefined, 'aria-describedby': describedBy })}
      {error ? (
        <p id={errorId} className="text-xs text-critical">
          {error}
        </p>
      ) : hint ? (
        <p id={hintId} className="text-xs text-fg-muted">
          {hint}
        </p>
      ) : null}
    </div>
  );
}
