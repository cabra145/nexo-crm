import type { Metadata } from 'next';
import { ContactsView } from './contacts-view';

export const metadata: Metadata = { title: 'Contactos' };

export default async function ContactsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return <ContactsView slug={slug} />;
}
