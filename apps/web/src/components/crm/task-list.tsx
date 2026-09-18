'use client';

import { TASK_PRIORITY_LABELS, type TaskPriority, type TaskView } from '@nexo/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Trash2 } from 'lucide-react';
import { useState } from 'react';
import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { crmApi } from '@/lib/crm/api';
import { cn } from '@/lib/utils';

const dayFormat = new Intl.DateTimeFormat('es', { day: 'numeric', month: 'short' });
const timeFormat = new Intl.DateTimeFormat('es', { hour: '2-digit', minute: '2-digit' });

const PRIORITY_TONE: Record<TaskPriority, 'neutral' | 'primary' | 'warning' | 'critical'> = {
  LOW: 'neutral',
  MEDIUM: 'neutral',
  HIGH: 'warning',
  URGENT: 'critical',
};

/**
 * Lista de tareas con la casilla para completarlas.
 *
 * La casilla es lo primero y lo más grande: completar es lo que se hace mil
 * veces al día. Al marcarla, la lista se recarga y la tarea salta al tramo de
 * hechas.
 */
export function TaskList({
  tasks,
  slug,
  showContact = true,
  canWrite,
}: {
  tasks: TaskView[];
  slug: string;
  showContact?: boolean;
  canWrite: boolean;
}) {
  const queryClient = useQueryClient();
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['crm'] });
  // La casilla responde al instante y se corrige si la API falla: marcar algo
  // como hecho tiene que sentirse inmediato, no esperar la ida y vuelta.
  const [optimistic, setOptimistic] = useState<Record<string, boolean>>({});

  const toggle = useMutation({
    mutationFn: ({ id, done }: { id: string; done: boolean }) =>
      crmApi.updateTask(id, { status: done ? 'DONE' : 'PENDING' }),
    onMutate: ({ id, done }) => setOptimistic((o) => ({ ...o, [id]: done })),
    onError: (_error, { id }) =>
      setOptimistic((o) => {
        const next = { ...o };
        delete next[id];
        return next;
      }),
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: (id: string) => crmApi.deleteTask(id),
    onSuccess: refresh,
  });

  return (
    <ul className="divide-y divide-border rounded-lg border border-border bg-surface">
      {tasks.map((task) => {
        const done = optimistic[task.id] ?? (task.status === 'DONE' || task.status === 'CANCELLED');
        const overdue = !done && task.dueAt !== null && new Date(task.dueAt) < new Date();
        return (
          <li
            key={task.id}
            className="flex items-start gap-3 px-4 py-3"
            data-testid={`tarea-${task.id}`}
          >
            <input
              type="checkbox"
              className="mt-0.5 size-4.5 shrink-0 accent-primary"
              checked={done}
              disabled={!canWrite}
              aria-label={done ? `Reabrir «${task.title}»` : `Completar «${task.title}»`}
              onChange={(e) => toggle.mutate({ id: task.id, done: e.target.checked })}
            />
            <div className="min-w-0 flex-1">
              <p className={cn('text-sm', done && 'text-fg-muted line-through')}>{task.title}</p>
              <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-fg-muted">
                {task.dueAt ? (
                  <span className={overdue ? 'font-medium text-critical' : undefined}>
                    {dayFormat.format(new Date(task.dueAt))} ·{' '}
                    {timeFormat.format(new Date(task.dueAt))}
                  </span>
                ) : (
                  <span>Sin fecha</span>
                )}
                {showContact && task.contact ? (
                  <>
                    <span aria-hidden>·</span>
                    <Link
                      href={`/w/${slug}/contactos/${task.contact.id}`}
                      className="text-primary hover:underline"
                    >
                      {task.contact.fullName}
                    </Link>
                  </>
                ) : null}
                {task.assignee ? (
                  <>
                    <span aria-hidden>·</span>
                    <span>{task.assignee.name}</span>
                  </>
                ) : null}
              </p>
            </div>
            {task.priority !== 'MEDIUM' && task.priority !== 'LOW' ? (
              <Badge tone={PRIORITY_TONE[task.priority]}>
                {TASK_PRIORITY_LABELS[task.priority]}
              </Badge>
            ) : null}
            {canWrite ? (
              <Button
                size="icon"
                variant="ghost"
                aria-label={`Eliminar «${task.title}»`}
                disabled={remove.isPending}
                onClick={() => remove.mutate(task.id)}
              >
                <Trash2 aria-hidden />
              </Button>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
