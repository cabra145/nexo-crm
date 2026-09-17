import type { Metadata } from 'next';
import { TwoFactorSettings } from './two-factor-settings';

export const metadata: Metadata = { title: 'Seguridad' };

export default function SecurityPage() {
  return (
    <div className="mx-auto max-w-2xl px-6 py-10">
      <h1 className="text-2xl font-semibold tracking-tight">Seguridad</h1>
      <p className="mt-1 text-fg-muted">Cómo se protege el acceso a tu cuenta.</p>
      <TwoFactorSettings />
    </div>
  );
}
