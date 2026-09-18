import type { Metadata } from 'next';
import { TasksView } from './tasks-view';

export const metadata: Metadata = { title: 'Tareas' };

export default async function TasksPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return <TasksView slug={slug} />;
}
