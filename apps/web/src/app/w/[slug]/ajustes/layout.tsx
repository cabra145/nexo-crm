import type { ReactNode } from 'react';
import { SettingsNav } from './settings-nav';

export default async function SettingsLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  return (
    <div className="mx-auto w-full max-w-5xl min-w-0 px-4 py-8 sm:px-6">
      <h1 className="text-2xl font-semibold tracking-tight">Ajustes</h1>
      <SettingsNav slug={slug} />
      <div className="mt-8">{children}</div>
    </div>
  );
}
