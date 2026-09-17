import type { Metadata } from 'next';
import { ContactDetailView } from './contact-detail-view';

export const metadata: Metadata = { title: 'Contacto' };

export default async function ContactPage({
  params,
}: {
  params: Promise<{ slug: string; id: string }>;
}) {
  const { slug, id } = await params;
  return <ContactDetailView slug={slug} id={id} />;
}
