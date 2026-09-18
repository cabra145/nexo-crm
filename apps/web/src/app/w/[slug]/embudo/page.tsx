import type { Metadata } from 'next';
import { BoardView } from './board-view';

export const metadata: Metadata = { title: 'Embudo' };

export default async function BoardPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return <BoardView slug={slug} />;
}
