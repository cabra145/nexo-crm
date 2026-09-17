import type { Metadata } from 'next';
import { Suspense } from 'react';
import { AcceptInvitation } from './accept-invitation';

export const metadata: Metadata = {
  title: 'Invitación',
  // El enlace lleva un token de un solo uso: que no viaje en el Referer.
  referrer: 'no-referrer',
};

export default function InvitationPage() {
  return (
    <Suspense>
      <AcceptInvitation />
    </Suspense>
  );
}
