import type { Metadata } from 'next';
import { TwoFactorSettings } from './two-factor-settings';

export const metadata: Metadata = { title: 'Seguridad' };

export default function SecurityPage() {
  return (
    <div className="max-w-2xl">
      <h2 className="text-lg font-semibold">Seguridad de tu cuenta</h2>
      <p className="mt-1 text-sm text-fg-muted">Cómo se protege el acceso a tu cuenta.</p>
      <TwoFactorSettings />
    </div>
  );
}
