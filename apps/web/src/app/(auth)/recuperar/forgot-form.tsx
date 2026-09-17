'use client';

import { emailSchema } from '@nexo/contracts';
import { MailCheck } from 'lucide-react';
import Link from 'next/link';
import { type FormEvent, useState } from 'react';
import { AuthShell } from '@/components/auth/auth-shell';
import { ProblemAlert } from '@/components/auth/problem-alert';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { authApi } from '@/lib/auth/api';

export function ForgotForm() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [pending, setPending] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!emailSchema.safeParse(email).success) return;
    setPending(true);
    setError(null);
    try {
      await authApi.forgotPassword(email);
      setSent(true);
    } catch (err) {
      setError(err);
    } finally {
      setPending(false);
    }
  }

  const back = (
    <Link href="/login" className="font-medium text-primary underline-offset-4 hover:underline">
      Volver a iniciar sesión
    </Link>
  );

  if (sent) {
    return (
      // El mensaje es el mismo exista o no la cuenta: la pantalla no revela
      // quién tiene cuenta.
      <AuthShell title="Revisa tu correo" footer={back}>
        <div className="flex items-start gap-3 rounded-lg border border-border bg-surface p-4">
          <MailCheck className="mt-0.5 size-5 shrink-0 text-primary" aria-hidden />
          <p className="text-sm text-fg-muted">
            Si <span className="font-medium text-fg">{email}</span> tiene una cuenta, recibirás un
            enlace para elegir una contraseña nueva. Caduca en 60 minutos.
          </p>
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title="Recupera tu contraseña"
      description="Escribe el correo de tu cuenta y te enviaremos un enlace para elegir una nueva."
      footer={back}
    >
      <form onSubmit={submit} className="grid gap-5" noValidate>
        <ProblemAlert error={error} />
        <Field label="Correo">
          {(a) => (
            <Input
              {...a}
              type="email"
              autoComplete="email"
              autoFocus
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          )}
        </Field>
        <Button type="submit" size="lg" disabled={pending || !email}>
          {pending ? 'Enviando…' : 'Enviar enlace'}
        </Button>
      </form>
    </AuthShell>
  );
}
