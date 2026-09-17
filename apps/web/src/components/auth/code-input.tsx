'use client';

import type { ComponentProps } from 'react';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

/**
 * Código de 6 dígitos del autenticador.
 *
 * Un solo campo y no seis casillas: pegar, autocompletar desde el teléfono
 * (`one-time-code`) y los lectores de pantalla funcionan sin trucos.
 */
export function CodeInput({
  className,
  onChange,
  ...props
}: Omit<ComponentProps<'input'>, 'type'>) {
  return (
    <Input
      {...props}
      type="text"
      inputMode="numeric"
      autoComplete="one-time-code"
      pattern="[0-9]{6}"
      maxLength={6}
      placeholder="000000"
      onChange={(event) => {
        event.target.value = event.target.value.replace(/\D/g, '').slice(0, 6);
        onChange?.(event);
      }}
      className={cn(
        'h-12 text-center font-mono text-2xl tracking-[0.5em] placeholder:tracking-[0.5em]',
        className,
      )}
    />
  );
}
