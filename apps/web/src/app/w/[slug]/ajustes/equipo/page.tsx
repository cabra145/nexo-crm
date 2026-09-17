import type { Metadata } from 'next';
import { TeamSettings } from './team-settings';

export const metadata: Metadata = { title: 'Equipo' };

export default function TeamPage() {
  return <TeamSettings />;
}
