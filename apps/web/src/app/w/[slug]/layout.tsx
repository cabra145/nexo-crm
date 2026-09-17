import type { ReactNode } from 'react';
import { SessionGate } from '@/components/app/session-gate';

export default async function WorkspaceLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  return <SessionGate slug={slug}>{children}</SessionGate>;
}
