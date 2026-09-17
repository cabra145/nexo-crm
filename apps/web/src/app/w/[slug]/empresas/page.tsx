import type { Metadata } from 'next';
import { CompaniesView } from './companies-view';

export const metadata: Metadata = { title: 'Empresas' };

export default async function CompaniesPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return <CompaniesView slug={slug} />;
}
