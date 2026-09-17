'use client';

import { emailSchema } from '@nexo/contracts';
import { CheckCircle2 } from 'lucide-react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { type FormEvent, useEffect, useRef, useState } from 'react';
import { AuthShell } from '@/components/auth/auth-shell';
import { ProblemAlert } from '@/components/auth/problem-alert';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { authApi } from '@/lib/auth/api';

type State = 'verifying' | 'verified' | 'failed';

export function VerifyEmail() {
  const params = useSearchParams();
  // Se lee una vez: el efecto limpia la URL justo después.
  const [token] = useState(() => params.get('token'));
  const [state, setState] = useState<State>(token ? 'verifying' : 'failed');
  const [error, setError] = useState<unknown>(null);
  const [email, setEmail] = useState('');
  const [resent, setResent] = useState(false);
  // El token es de un solo uso. En desarrollo, React ejecuta los efectos dos
  // veces: sin esta guarda, la segunda llamada vería el token ya usado y la
  // pantalla mostraría un error después de haberlo confirmado.
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;

    // Se quita el token de la barra de direcciones y del historial.
    window.history.replaceState(null, '', '/verificar-correo');
    if (!token) return;
    authApi
      .verifyEmail(token)
      .then(() => setState('verified'))
      .catch((err: unknown) => {
        setError(err);
        setState('failed');
      });
  }, [token]);

  async function resend(event: FormEvent) {
    event.preventDefault();
    if (!emailSchema.safeParse(email).success) return;
    await authApi.resendVerification(email);
    setResent(true);
  }

  if (state === 'verifying') {
    return (
      <AuthShell title="Confirmando tu correo…">
        <div className="h-24 animate-pulse rounded-lg bg-surface-sunken" />
      </AuthShell>
    );
  }

  if (state === 'verified') {
    return (
      <AuthShell title="Correo confirmado">
        <div className="grid gap-5">
          <div className="flex items-center gap-3 rounded-lg border border-positive/30 bg-positive-subtle p-4">
            <CheckCircle2 className="size-5 shrink-0 text-positive" aria-hidden />
            <p className="text-sm">
              Tu cuenta está activa. Ya puedes entrar en tu espacio de trabajo.
            </p>
          </div>
          <Button asChild size="lg">
            <Link href="/login">Iniciar sesión</Link>
          </Button>
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title="El enlace no funciona"
      description="Puede que haya caducado (duran 24 horas) o que ya lo hayas usado. Si ya confirmaste el correo, simplemente inicia sesión."
      footer={
        <Link href="/login" className="font-medium text-primary underline-offset-4 hover:underline">
          Iniciar sesión
        </Link>
      }
    >
      {resent ? (
        <p className="rounded-lg border border-border bg-surface p-4 text-sm text-fg-muted">
          Si ese correo tiene una cuenta pendiente de confirmar, te enviamos un enlace nuevo.
        </p>
      ) : (
        <form onSubmit={resend} className="grid gap-4">
          <ProblemAlert error={error} className={error ? '' : 'hidden'} />
          <Field label="Tu correo" hint="Te enviaremos un enlace nuevo.">
            {(a) => (
              <Input
                {...a}
                type="email"
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            )}
          </Field>
          <Button type="submit" variant="secondary" disabled={!email}>
            Enviar un enlace nuevo
          </Button>
        </form>
      )}
    </AuthShell>
  );
}
