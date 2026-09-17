import type { Metadata } from 'next';
import { Suspense } from 'react';
import { VerifyEmail } from './verify-email';

export const metadata: Metadata = {
  title: 'Confirmar correo',
  // El enlace lleva un token de un solo uso: que no viaje en la cabecera
  // Referer a ningún otro sitio.
  referrer: 'no-referrer',
};

export default function VerifyEmailPage() {
  return (
    <Suspense>
      <VerifyEmail />
    </Suspense>
  );
}
