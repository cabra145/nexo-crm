'use client';

import { MailCheck } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { AuthShell } from '@/components/auth/auth-shell';
import { Button } from '@/components/ui/button';
import { authApi } from '@/lib/auth/api';
import { REGISTERED_EMAIL_KEY } from '../register-form';

/** Espera entre reenvíos. La API limita a 3 correos por hora por dirección. */
const COOLDOWN_SECONDS = 60;

const noSubscribe = () => () => {};
function readRegisteredEmail() {
  try {
    return sessionStorage.getItem(REGISTERED_EMAIL_KEY);
  } catch {
    return null;
  }
}

export function CheckEmail() {
  // sessionStorage sólo existe en el navegador: en el servidor, sin correo.
  const email = useSyncExternalStore(noSubscribe, readRegisteredEmail, () => null);
  const [cooldown, setCooldown] = useState(COOLDOWN_SECONDS);
  const [sent, setSent] = useState(false);

  useEffect(() => {
    if (cooldown <= 0) return;
    const id = setTimeout(() => setCooldown((s) => s - 1), 1000);
    return () => clearTimeout(id);
  }, [cooldown]);

  return (
    <AuthShell
      title="Revisa tu correo"
      description={
        email ? (
          <>
            Te enviamos un enlace a <span className="font-medium text-fg">{email}</span> para
            confirmar que es tuyo.
          </>
        ) : (
          'Te enviamos un enlace para confirmar que el correo es tuyo.'
        )
      }
      footer={
        <Link href="/login" className="font-medium text-primary underline-offset-4 hover:underline">
          Volver a iniciar sesión
        </Link>
      }
    >
      <div className="grid gap-5">
        <div className="flex items-start gap-3 rounded-lg border border-border bg-surface p-4">
          <MailCheck className="mt-0.5 size-5 shrink-0 text-primary" aria-hidden />
          <p className="text-sm text-fg-muted">
            El enlace caduca en 24 horas. Si no lo ves en unos minutos, mira en la carpeta de spam o
            de promociones.
          </p>
        </div>

        {email ? (
          <Button
            variant="secondary"
            disabled={cooldown > 0}
            onClick={() => {
              void authApi.resendVerification(email).then(() => {
                setSent(true);
                setCooldown(COOLDOWN_SECONDS);
              });
            }}
          >
            {cooldown > 0
              ? `Reenviar en ${cooldown} s`
              : sent
                ? 'Reenviar otra vez'
                : 'Reenviar el enlace'}
          </Button>
        ) : null}
        {sent ? <p className="text-center text-sm text-positive">Enlace reenviado.</p> : null}
      </div>
    </AuthShell>
  );
}
