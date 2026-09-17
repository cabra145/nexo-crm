'use client';

import { AUTH_PROBLEMS, passwordSchema } from '@nexo/contracts';
import { CheckCircle2 } from 'lucide-react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { type FormEvent, useEffect, useState } from 'react';
import { AuthShell } from '@/components/auth/auth-shell';
import { PasswordInput, PasswordRules } from '@/components/auth/password-field';
import { ProblemAlert } from '@/components/auth/problem-alert';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { ApiError } from '@/lib/api/client';
import { authApi } from '@/lib/auth/api';

export function ResetForm() {
  const params = useSearchParams();
  // Se lee una vez al montar: después se limpia la URL. La página envuelve el
  // formulario en <Suspense>, así que esto sólo se renderiza en el navegador,
  // ya con los parámetros reales (sin destello de «enlace no válido»).
  const [token] = useState(() => params.get('token'));
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [done, setDone] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    // Fuera de la barra de direcciones y del historial.
    window.history.replaceState(null, '', '/restablecer');
  }, []);

  const invalidLink =
    error instanceof ApiError && error.problem.type === AUTH_PROBLEMS.TOKEN_INVALID;
  const valid = passwordSchema.safeParse(password).success;
  const mismatch = confirm.length > 0 && confirm !== password;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!token || !valid || mismatch) return;
    setPending(true);
    setError(null);
    try {
      await authApi.resetPassword(token, password);
      setDone(true);
    } catch (err) {
      setError(err);
    } finally {
      setPending(false);
    }
  }

  if (done) {
    return (
      <AuthShell title="Contraseña actualizada">
        <div className="grid gap-5">
          <div className="flex items-start gap-3 rounded-lg border border-positive/30 bg-positive-subtle p-4">
            <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-positive" aria-hidden />
            <p className="text-sm">
              Por seguridad cerramos todas las sesiones abiertas. Entra con tu contraseña nueva.
            </p>
          </div>
          <Button asChild size="lg">
            <Link href="/login">Iniciar sesión</Link>
          </Button>
        </div>
      </AuthShell>
    );
  }

  if (token === undefined) {
    return (
      <AuthShell title="Elige una contraseña nueva">
        <div className="h-40 animate-pulse rounded-lg bg-surface-sunken" />
      </AuthShell>
    );
  }

  if (token === null || invalidLink) {
    return (
      <AuthShell
        title="El enlace no funciona"
        description="Los enlaces para restablecer la contraseña caducan en 60 minutos y sirven una sola vez."
      >
        <Button asChild size="lg" className="w-full">
          <Link href="/recuperar">Pedir un enlace nuevo</Link>
        </Button>
      </AuthShell>
    );
  }

  return (
    <AuthShell title="Elige una contraseña nueva">
      <form onSubmit={submit} className="grid gap-5" noValidate>
        <ProblemAlert error={error} />
        <Field label="Contraseña nueva">
          {(a) => (
            <div className="grid gap-1">
              <PasswordInput
                {...a}
                autoComplete="new-password"
                autoFocus
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
              <PasswordRules value={password} />
            </div>
          )}
        </Field>
        <Field label="Repítela" error={mismatch ? 'No coincide con la anterior' : undefined}>
          {(a) => (
            <PasswordInput
              {...a}
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
            />
          )}
        </Field>
        <Button type="submit" size="lg" disabled={pending || !valid || confirm !== password}>
          {pending ? 'Guardando…' : 'Guardar contraseña'}
        </Button>
      </form>
    </AuthShell>
  );
}
