import type { Metadata } from 'next';
import { Suspense } from 'react';
import { ResetForm } from './reset-form';

export const metadata: Metadata = { title: 'Nueva contraseña', referrer: 'no-referrer' };

export default function ResetPage() {
  return (
    <Suspense>
      <ResetForm />
    </Suspense>
  );
}
