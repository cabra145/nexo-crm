import type { Metadata } from 'next';
import { ChannelsSettings } from './channels-settings';

export const metadata: Metadata = { title: 'Canales' };

export default function ChannelsPage() {
  return <ChannelsSettings />;
}
