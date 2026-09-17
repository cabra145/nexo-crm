import type { Metadata } from 'next';
import { CompanyDetailView } from './company-detail-view';

export const metadata: Metadata = { title: 'Empresa' };

export default async function CompanyPage({
  params,
}: {
  params: Promise<{ slug: string; id: string }>;
}) {
  const { slug, id } = await params;
  return <CompanyDetailView slug={slug} id={id} />;
}
