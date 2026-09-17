import type { Metadata } from 'next';
import { RolesSettings } from './roles-settings';

export const metadata: Metadata = { title: 'Roles' };

export default function RolesPage() {
  return <RolesSettings />;
}
