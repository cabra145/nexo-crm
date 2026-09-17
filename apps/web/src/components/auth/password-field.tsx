'use client';

import { Check, Eye, EyeOff } from 'lucide-react';
import { useState, type ComponentProps } from 'react';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

/** Las mismas reglas que `passwordSchema` en @nexo/contracts. */
const RULES = [
  { label: '12 caracteres o más', test: (v: string) => v.length >= 12 },
  { label: 'Una mayúscula', test: (v: string) => /[A-Z]/.test(v) },
  { label: 'Una minúscula', test: (v: string) => /[a-z]/.test(v) },
  { label: 'Un número', test: (v: string) => /\d/.test(v) },
];

export function PasswordInput({ className, ...props }: ComponentProps<'input'>) {
  const [visible, setVisible] = useState(false);
  return (
    <div className="relative">
      <Input {...props} type={visible ? 'text' : 'password'} className={cn('pr-10', className)} />
      <button
        type="button"
        onClick={() => setVisible((v) => !v)}
        aria-label={visible ? 'Ocultar contraseña' : 'Mostrar contraseña'}
        aria-pressed={visible}
        className="absolute inset-y-0 right-0 grid w-10 place-items-center rounded-r-md text-fg-faint hover:text-fg-muted"
      >
        {visible ? (
          <EyeOff className="size-4" aria-hidden />
        ) : (
          <Eye className="size-4" aria-hidden />
        )}
      </button>
    </div>
  );
}

/**
 * Requisitos de la contraseña, marcados a medida que se cumplen.
 *
 * Una lista honesta de lo que se exige, no un medidor de "fortaleza" inventado:
 * dice exactamente qué falta para que el formulario la acepte.
 */
export function PasswordRules({ value }: { value: string }) {
  return (
    <ul className="grid grid-cols-2 gap-x-4 gap-y-1 pt-1" aria-label="Requisitos de la contraseña">
      {RULES.map((rule) => {
        const ok = rule.test(value);
        return (
          <li
            key={rule.label}
            className={cn(
              'flex items-center gap-1.5 text-xs transition-colors',
              ok ? 'text-positive' : 'text-fg-faint',
            )}
          >
            <Check className={cn('size-3.5', ok ? 'opacity-100' : 'opacity-30')} aria-hidden />
            <span>{rule.label}</span>
            <span className="sr-only">{ok ? 'cumplido' : 'pendiente'}</span>
          </li>
        );
      })}
    </ul>
  );
}
