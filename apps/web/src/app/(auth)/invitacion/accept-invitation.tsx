'use client';

import { acceptInvitationNewAccountSchema, type SessionResponse } from '@nexo/contracts';
import { useQuery } from '@tanstack/react-query';
import { Building2 } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { type FormEvent, useEffect, useState } from 'react';
import { AuthShell } from '@/components/auth/auth-shell';
import { PasswordInput, PasswordRules } from '@/components/auth/password-field';
import { ProblemAlert } from '@/components/auth/problem-alert';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { authApi } from '@/lib/auth/api';
import { applySession, logout, refreshSession } from '@/lib/auth/session';
import { teamApi } from '@/lib/team/api';
import { invitationStorage } from '@/lib/team/invitation-storage';

export function AcceptInvitation() {
  const router = useRouter();
  const params = useSearchParams();
  // Se lee una vez: el efecto lo quita de la URL. Si se vuelve aquí desde el
  // inicio de sesión, sigue en sessionStorage.
  const [token] = useState(() => params.get('token') ?? invitationStorage.get());

  useEffect(() => {
    if (!token) return;
    invitationStorage.set(token);
    window.history.replaceState(null, '', '/invitacion');
  }, [token]);

  const preview = useQuery({
    queryKey: ['invitation', token],
    queryFn: () => teamApi.previewInvitation(token!),
    enabled: Boolean(token),
    retry: false,
  });
  // ¿Hay ya una sesión en este navegador, y de quién?
  const session = useQuery({
    queryKey: ['invitation-session'],
    queryFn: () => refreshSession().catch(() => null),
    enabled: Boolean(preview.data?.accountExists),
    retry: false,
  });

  const enter = (next: SessionResponse) => {
    invitationStorage.clear();
    applySession(next);
    router.replace(`/w/${next.activeTenant.tenantSlug}`);
  };

  if (!token || preview.error) {
    return (
      <AuthShell
        title="La invitación no funciona"
        description="El enlace caducó, ya se usó o la invitación se canceló. Pide a quien te invitó que te envíe una nueva."
      >
        <Button asChild size="lg" className="w-full">
          <Link href="/login">Ir al inicio de sesión</Link>
        </Button>
      </AuthShell>
    );
  }

  if (preview.isLoading || !preview.data || (preview.data.accountExists && session.isLoading)) {
    return (
      <AuthShell title="Abriendo la invitación…">
        <div className="h-40 animate-pulse rounded-lg bg-surface-sunken" aria-busy="true" />
      </AuthShell>
    );
  }

  const invitation = preview.data;
  const heading = (
    <div className="flex items-start gap-3 rounded-lg border border-border bg-surface p-4">
      <Building2 className="mt-0.5 size-5 shrink-0 text-primary" aria-hidden />
      <p className="text-sm">
        {invitation.inviterName ? `${invitation.inviterName} te invita` : 'Te invitan'} a{' '}
        <strong>{invitation.tenantName}</strong> como <strong>{invitation.roleName}</strong>.
      </p>
    </div>
  );

  if (!invitation.accountExists) {
    return (
      <AuthShell title={`Únete a ${invitation.tenantName}`} description={invitation.email}>
        <div className="grid gap-5">
          {heading}
          <NewAccountForm token={token} onDone={enter} />
        </div>
      </AuthShell>
    );
  }

  const current = session.data;
  return (
    <AuthShell title={`Únete a ${invitation.tenantName}`} description={invitation.email}>
      <div className="grid gap-5">
        {heading}
        {current && current.user.email === invitation.email ? (
          <AcceptWithSession token={token} onDone={enter} />
        ) : current ? (
          <div className="grid gap-4">
            <p className="text-sm text-fg-muted">
              Tienes abierta la sesión de <strong className="text-fg">{current.user.email}</strong>,
              pero la invitación es para <strong className="text-fg">{invitation.email}</strong>.
            </p>
            <Button
              size="lg"
              onClick={() => void logout().then(() => router.push('/login?invitacion=1'))}
            >
              Cerrar sesión y entrar con {invitation.email}
            </Button>
          </div>
        ) : (
          <div className="grid gap-4">
            <p className="text-sm text-fg-muted">
              Ya tienes una cuenta con este correo. Inicia sesión y entrarás directamente en{' '}
              {invitation.tenantName}.
            </p>
            <Button asChild size="lg">
              <Link href="/login?invitacion=1">Iniciar sesión para aceptar</Link>
            </Button>
          </div>
        )}
      </div>
    </AuthShell>
  );
}

function NewAccountForm({
  token,
  onDone,
}: {
  token: string;
  onDone: (session: SessionResponse) => void;
}) {
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [pending, setPending] = useState(false);
  const parsed = acceptInvitationNewAccountSchema.safeParse({ token, name, password });

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!parsed.success) return;
    setPending(true);
    setError(null);
    try {
      onDone(await teamApi.acceptWithNewAccount(parsed.data));
    } catch (err) {
      setError(err);
      setPending(false);
    }
  }

  return (
    <form onSubmit={submit} className="grid gap-5" noValidate>
      <ProblemAlert error={error} />
      <Field label="Tu nombre">
        {(a) => (
          <Input
            {...a}
            autoComplete="name"
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        )}
      </Field>
      <Field label="Elige una contraseña">
        {(a) => (
          <>
            <PasswordInput
              {...a}
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            <PasswordRules value={password} />
          </>
        )}
      </Field>
      <Button type="submit" size="lg" disabled={!parsed.success || pending}>
        {pending ? 'Entrando…' : 'Aceptar y entrar'}
      </Button>
    </form>
  );
}

function AcceptWithSession({
  token,
  onDone,
}: {
  token: string;
  onDone: (session: SessionResponse) => void;
}) {
  const [error, setError] = useState<unknown>(null);
  const [pending, setPending] = useState(false);

  async function accept() {
    setPending(true);
    setError(null);
    try {
      const accepted = await teamApi.acceptWithSession(token);
      // La sesión se mueve a la empresa que invita.
      onDone(await authApi.switchTenant(accepted.tenantId));
    } catch (err) {
      setError(err);
      setPending(false);
    }
  }

  return (
    <div className="grid gap-4">
      <ProblemAlert error={error} />
      <Button size="lg" disabled={pending} onClick={() => void accept()}>
        {pending ? 'Uniéndote…' : 'Aceptar la invitación'}
      </Button>
    </div>
  );
}
