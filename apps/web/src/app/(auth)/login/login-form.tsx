'use client';

import { AUTH_PROBLEMS, loginSchema, type SessionResponse, TEAM_PROBLEMS } from '@nexo/contracts';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { type FormEvent, useEffect, useState } from 'react';
import { AuthShell } from '@/components/auth/auth-shell';
import { CodeInput } from '@/components/auth/code-input';
import { PasswordInput } from '@/components/auth/password-field';
import { ProblemAlert } from '@/components/auth/problem-alert';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { ApiError } from '@/lib/api/client';
import { authApi, safeNext } from '@/lib/auth/api';
import { applySession, refreshSession } from '@/lib/auth/session';
import { invitationStorage } from '@/lib/team/invitation-storage';

type Step = { kind: 'credentials' } | { kind: 'two-factor'; challengeToken: string };

export function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();

  const [step, setStep] = useState<Step>({ kind: 'credentials' });
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [recovery, setRecovery] = useState('');
  const [useRecovery, setUseRecovery] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [pending, setPending] = useState(false);
  const [resent, setResent] = useState(false);
  // Inicio de sesión para aceptar una invitación (viene de /invitacion).
  const [invitationToken, setInvitationToken] = useState(() =>
    params.get('invitacion') ? invitationStorage.get() : null,
  );

  const enter = (session: SessionResponse) => {
    invitationStorage.clear();
    applySession(session);
    router.replace(safeNext(params.get('next'), `/w/${session.activeTenant.tenantSlug}`));
  };

  // Con una sesión ya abierta en el navegador, no tiene sentido pedir credenciales.
  useEffect(() => {
    refreshSession()
      .then((session) => {
        if (session)
          router.replace(safeNext(params.get('next'), `/w/${session.activeTenant.tenantSlug}`));
      })
      // Sin API no hay sesión que recuperar; el formulario mostrará el error al enviarlo.
      .catch(() => undefined);
  }, [params, router]);

  const unverified =
    error instanceof ApiError && error.problem.type === AUTH_PROBLEMS.EMAIL_NOT_VERIFIED;

  async function submitCredentials(event: FormEvent) {
    event.preventDefault();
    const parsed = loginSchema.safeParse({
      email,
      password,
      tenantSlug: params.get('empresa') ?? undefined,
      invitationToken: invitationToken ?? undefined,
    });
    if (!parsed.success) return;

    setPending(true);
    setError(null);
    setResent(false);
    try {
      const result = await authApi.login(parsed.data);
      if ('requiresTwoFactor' in result) {
        setStep({ kind: 'two-factor', challengeToken: result.challengeToken });
      } else {
        enter(result);
      }
    } catch (err) {
      // La invitación ya no vale (o es de otra cuenta): se sigue sin ella, y
      // el error lo explica.
      if (
        err instanceof ApiError &&
        (err.problem.type === AUTH_PROBLEMS.TOKEN_INVALID ||
          err.problem.type === TEAM_PROBLEMS.INVITATION_EMAIL_MISMATCH)
      ) {
        invitationStorage.clear();
        setInvitationToken(null);
      }
      setError(err);
    } finally {
      setPending(false);
    }
  }

  async function submitTwoFactor(event: FormEvent) {
    event.preventDefault();
    if (step.kind !== 'two-factor') return;
    setPending(true);
    setError(null);
    try {
      enter(
        await authApi.loginTwoFactor({
          challengeToken: step.challengeToken,
          ...(useRecovery ? { recoveryCode: recovery } : { code }),
        }),
      );
    } catch (err) {
      // El desafío dura 5 minutos: si caducó, se vuelve a pedir la contraseña.
      if (err instanceof ApiError && err.problem.type === AUTH_PROBLEMS.SESSION_EXPIRED) {
        setStep({ kind: 'credentials' });
        setPassword('');
      }
      setError(err);
    } finally {
      setPending(false);
    }
  }

  if (step.kind === 'two-factor') {
    return (
      <AuthShell
        title="Verificación en dos pasos"
        description={
          useRecovery
            ? 'Escribe uno de tus códigos de recuperación. Cada uno sirve una sola vez.'
            : 'Abre tu aplicación de autenticación y escribe el código de 6 dígitos.'
        }
      >
        <form onSubmit={submitTwoFactor} className="grid gap-5" noValidate>
          <ProblemAlert error={error} />
          {useRecovery ? (
            <Field label="Código de recuperación">
              {(a) => (
                <Input
                  {...a}
                  value={recovery}
                  onChange={(e) => setRecovery(e.target.value.toUpperCase())}
                  placeholder="XXXXX-XXXXX"
                  autoComplete="off"
                  autoFocus
                  className="font-mono tracking-wider"
                />
              )}
            </Field>
          ) : (
            <Field label="Código">
              {(a) => (
                <CodeInput
                  {...a}
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  autoFocus
                />
              )}
            </Field>
          )}
          <Button
            type="submit"
            size="lg"
            disabled={pending || (useRecovery ? recovery.length < 11 : code.length !== 6)}
          >
            {pending ? 'Comprobando…' : 'Entrar'}
          </Button>
          <button
            type="button"
            onClick={() => {
              setUseRecovery((v) => !v);
              setError(null);
            }}
            className="text-sm text-fg-muted underline-offset-4 hover:text-fg hover:underline"
          >
            {useRecovery
              ? 'Usar el código del autenticador'
              : '¿Perdiste el teléfono? Usa un código de recuperación'}
          </button>
        </form>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title="Inicia sesión"
      description={
        invitationToken
          ? 'Entra con tu cuenta para aceptar la invitación.'
          : 'Entra en el espacio de trabajo de tu empresa.'
      }
      footer={
        <>
          ¿Todavía no tienes cuenta?{' '}
          <Link
            href="/registro"
            className="font-medium text-primary underline-offset-4 hover:underline"
          >
            Crea tu empresa
          </Link>
        </>
      }
    >
      <form onSubmit={submitCredentials} className="grid gap-5" noValidate>
        {unverified ? (
          <Alert tone="warning" title="Confirma tu correo para entrar">
            Te enviamos un enlace al registrarte.{' '}
            {resent ? (
              'Te acabamos de enviar otro.'
            ) : (
              <button
                type="button"
                className="font-medium text-fg underline underline-offset-4"
                onClick={() => void authApi.resendVerification(email).then(() => setResent(true))}
              >
                Enviar otro enlace
              </button>
            )}
          </Alert>
        ) : (
          <ProblemAlert error={error} />
        )}

        <Field label="Correo">
          {(a) => (
            <Input
              {...a}
              type="email"
              autoComplete="email"
              autoFocus
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          )}
        </Field>

        <Field
          label="Contraseña"
          aside={
            <Link
              href="/recuperar"
              className="text-xs text-fg-muted underline-offset-4 hover:text-fg hover:underline"
            >
              ¿La olvidaste?
            </Link>
          }
        >
          {(a) => (
            <PasswordInput
              {...a}
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          )}
        </Field>

        <Button type="submit" size="lg" disabled={pending || !email || !password}>
          {pending ? 'Entrando…' : 'Entrar'}
        </Button>
      </form>
    </AuthShell>
  );
}
