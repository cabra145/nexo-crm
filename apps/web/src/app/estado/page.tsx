import type { Metadata } from 'next';
import { StatusView } from './status-view';

export const metadata: Metadata = {
  title: 'Estado del sistema',
};

export default function StatusPage() {
  return <StatusView />;
}
