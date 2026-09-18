import type { Metadata } from 'next';
import { Suspense } from 'react';
import { InboxView } from './inbox-view';

export const metadata: Metadata = { title: 'Bandeja' };

export default function InboxPage() {
  // useSearchParams (la conversación abierta) necesita un límite de Suspense.
  return (
    <Suspense>
      <InboxView />
    </Suspense>
  );
}
