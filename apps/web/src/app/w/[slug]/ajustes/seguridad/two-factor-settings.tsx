'use client';

import type { TwoFactorSetupResponse } from '@nexo/contracts';
import { ShieldCheck, Smartphone } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { type FormEvent, useState } from 'react';
import { CodeInput } from '@/components/auth/code-input';
import { PasswordInput } from '@/components/auth/password-field';
import { ProblemAlert } from '@/components/auth/problem-alert';
import { QrCode } from '@/components/auth/qr-code';
import { RecoveryCodes } from '@/components/auth/recovery-codes';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { authApi } from '@/lib/auth/api';
import { applySession, refreshSession } from '@/lib/auth/session';
import { useSessionStore } from '@/lib/auth/session-store';

type Step =
  | { kind: 'overview' }
  | { kind: 'scan'; setup: TwoFactorSetupResponse }
  | { kind: 'codes'; codes: string[] }
  | { kind: 'disable' };

/** "JBSWY3DPEHPK3PXP…" → "JBSW Y3DP EHPK 3PXP …": más fácil de copiar a mano. */
const groupKey = (secret: string) => secret.match(/.{1,4}/g)?.join(' ') ?? secret;

export function TwoFactorSettings() {
  const router = useRouter();
  const session = useSessionStore((s) => s.session);
  const [step, setStep] = useState<Step>({ kind: 'overview' });
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [pending, setPending] = useState(false);

  if (!session) return null;
  const { user, twoFactor, activeTenant } = session;

  const run = async (fn: () => Promise<void>) => {
    setPending(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(err);
    } finally {
      setPending(false);
    }
  };

  /* --- Paso 2: escanear y confirmar ------------------------------------- */
  if (step.kind === 'scan') {
    const confirm = (event: FormEvent) => {
      event.preventDefault();
      void run(async () => {
        const result = await authApi.enableTwoFactor(code);
        // La sesión se sustituye YA (la anterior quedó revocada al activar),
        // pero la pantalla sigue en los códigos hasta que confirme guardarlos.
        applySession(result.session);
        setCode('');
        setStep({ kind: 'codes', codes: result.recoveryCodes });
      });
    };

    return (
      <section className="mt-8 rounded-lg border border-border bg-surface p-6">
        <h2 className="text-lg font-semibold">Configura tu autenticador</h2>
        <ol className="mt-4 grid gap-6 md:grid-cols-[auto_1fr]">
          <li className="justify-self-center md:justify-self-start">
            <QrCode
              value={step.setup.otpauthUrl}
              label="Código QR para añadir la cuenta al autenticador"
            />
          </li>
          <li className="space-y-3 text-sm">
            <p>
              <span className="font-medium">1.</span> Abre Google Authenticator, 1Password, Authy o
              Microsoft Authenticator y escanea el código.
            </p>
            <p className="text-fg-muted">¿No puedes escanearlo? Introduce esta clave a mano:</p>
            <p
              className="rounded-md bg-surface-sunken px-3 py-2 font-mono text-sm tracking-wide break-all select-all"
              data-testid="clave-2fa"
            >
              {groupKey(step.setup.secret)}
            </p>
          </li>
        </ol>

        <form onSubmit={confirm} className="mt-6 grid max-w-xs gap-4" noValidate>
          <ProblemAlert error={error} />
          <Field label="2. Escribe el código que muestra">
            {(a) => (
              <CodeInput {...a} value={code} onChange={(e) => setCode(e.target.value)} autoFocus />
            )}
          </Field>
          <div className="flex gap-2">
            <Button type="submit" disabled={pending || code.length !== 6}>
              {pending ? 'Comprobando…' : 'Activar'}
            </Button>
            <Button type="button" variant="ghost" onClick={() => setStep({ kind: 'overview' })}>
              Cancelar
            </Button>
          </div>
        </form>
      </section>
    );
  }

  /* --- Paso 3: códigos de recuperación ---------------------------------- */
  if (step.kind === 'codes') {
    return (
      <section className="mt-8 space-y-5 rounded-lg border border-border bg-surface p-6">
        <div>
          <h2 className="text-lg font-semibold">Guarda tus códigos de recuperación</h2>
          <p className="mt-1 text-sm text-fg-muted">
            Si pierdes el teléfono, cada código te deja entrar una vez.{' '}
            <strong className="text-fg">No volverás a verlos</strong>: guárdalos ahora en un gestor
            de contraseñas.
          </p>
        </div>
        <RecoveryCodes codes={step.codes} account={user.email} />
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={saved}
            onChange={(e) => setSaved(e.target.checked)}
            className="size-4 accent-primary"
          />
          He guardado mis códigos en un lugar seguro
        </label>
        <Button
          disabled={!saved}
          onClick={() => {
            setSaved(false);
            setStep({ kind: 'overview' });
            router.replace(`/w/${activeTenant.tenantSlug}/ajustes/seguridad`);
          }}
        >
          Terminar
        </Button>
      </section>
    );
  }

  /* --- Desactivar --------------------------------------------------------- */
  if (step.kind === 'disable') {
    const disable = (event: FormEvent) => {
      event.preventDefault();
      void run(async () => {
        await authApi.disableTwoFactor(password, code);
        // El token actual sigue siendo válido pero su contenido ya no refleja
        // el estado del 2FA: se fuerza una sesión nueva.
        await refreshSession({ force: true });
        setPassword('');
        setCode('');
        setStep({ kind: 'overview' });
      });
    };
    return (
      <section className="mt-8 rounded-lg border border-border bg-surface p-6">
        <h2 className="text-lg font-semibold">Desactivar la verificación en dos pasos</h2>
        {twoFactor.required ? (
          <Alert tone="warning" title="Es obligatoria para tu rol" className="mt-4">
            Como propietario, si la desactivas tendrás que volver a activarla para seguir usando el
            producto.
          </Alert>
        ) : null}
        <form onSubmit={disable} className="mt-5 grid max-w-xs gap-4" noValidate>
          <ProblemAlert error={error} />
          <Field label="Contraseña">
            {(a) => (
              <PasswordInput
                {...a}
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            )}
          </Field>
          <Field label="Código del autenticador">
            {(a) => <CodeInput {...a} value={code} onChange={(e) => setCode(e.target.value)} />}
          </Field>
          <div className="flex gap-2">
            <Button
              type="submit"
              variant="destructive"
              disabled={pending || !password || code.length !== 6}
            >
              {pending ? 'Desactivando…' : 'Desactivar'}
            </Button>
            <Button type="button" variant="ghost" onClick={() => setStep({ kind: 'overview' })}>
              Cancelar
            </Button>
          </div>
        </form>
      </section>
    );
  }

  /* --- Resumen ------------------------------------------------------------- */
  return (
    <section className="mt-8 rounded-lg border border-border bg-surface p-6">
      <div className="flex items-start gap-4">
        <div
          className={
            user.twoFactorEnabled
              ? 'rounded-full bg-positive-subtle p-2.5'
              : 'rounded-full bg-surface-sunken p-2.5'
          }
        >
          {user.twoFactorEnabled ? (
            <ShieldCheck className="size-5 text-positive" aria-hidden />
          ) : (
            <Smartphone className="size-5 text-fg-muted" aria-hidden />
          )}
        </div>
        <div className="flex-1 space-y-1">
          <h2 className="font-semibold">Verificación en dos pasos</h2>
          <p className="text-sm text-fg-muted">
            {user.twoFactorEnabled
              ? 'Activa. Además de la contraseña, al entrar se pide un código de tu autenticador.'
              : 'Además de la contraseña, pide un código de tu teléfono al entrar. Si alguien consigue tu contraseña, no le basta.'}
          </p>
          {!user.twoFactorEnabled && twoFactor.required ? (
            <p className="text-sm font-medium text-warning">Obligatoria para propietarios.</p>
          ) : null}
        </div>
      </div>

      <div className="mt-5">
        <ProblemAlert error={error} className="mb-4" />
        {user.twoFactorEnabled ? (
          <Button variant="secondary" onClick={() => setStep({ kind: 'disable' })}>
            Desactivar
          </Button>
        ) : (
          <Button
            disabled={pending}
            onClick={() =>
              void run(async () => setStep({ kind: 'scan', setup: await authApi.setupTwoFactor() }))
            }
          >
            {pending ? 'Preparando…' : 'Activar'}
          </Button>
        )}
      </div>
    </section>
  );
}
