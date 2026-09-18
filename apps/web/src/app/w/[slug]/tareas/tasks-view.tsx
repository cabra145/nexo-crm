'use client';

import { TASK_BUCKET_LABELS, type TaskBucket } from '@nexo/contracts';
import { CheckSquare } from 'lucide-react';
import { useState } from 'react';
import { ProblemAlert } from '@/components/auth/problem-alert';
import { TaskComposer } from '@/components/crm/task-composer';
import { TaskList } from '@/components/crm/task-list';
import { useTasks } from '@/lib/crm/hooks';
import { useAccess } from '@/lib/team/use-access';
import { cn } from '@/lib/utils';

/** Orden de los tramos: primero lo que aprieta. */
const BUCKETS: TaskBucket[] = ['overdue', 'today', 'upcoming', 'someday', 'done'];

export function TasksView({ slug }: { slug: string }) {
  const { access, can } = useAccess();
  const [bucket, setBucket] = useState<TaskBucket>('today');
  const [mine, setMine] = useState(false);
  const tasks = useTasks({ bucket, ...(mine ? { mine: true } : {}) });
  const seesOthers = access?.permissions['task:read'] !== 'OWN';

  const rows = tasks.data?.data ?? [];

  return (
    <div className="mx-auto grid max-w-4xl grid-cols-[minmax(0,1fr)] gap-6 px-4 py-8 sm:px-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Tareas</h1>
        <p className="mt-1 text-sm text-fg-muted">Lo que hay que hacer, y cuándo.</p>
      </div>

      {can('task:write') ? <TaskComposer /> : null}

      <div className="flex flex-wrap items-center gap-2">
        <div
          role="tablist"
          aria-label="Tramos de la agenda"
          className="flex flex-wrap gap-1 rounded-lg border border-border bg-surface p-1"
        >
          {BUCKETS.map((b) => (
            <button
              key={b}
              type="button"
              role="tab"
              aria-selected={bucket === b}
              onClick={() => setBucket(b)}
              className={cn(
                'rounded-md px-3 py-1.5 text-sm transition-colors',
                bucket === b
                  ? 'bg-primary-subtle font-medium text-primary'
                  : 'text-fg-muted hover:text-fg',
              )}
            >
              {TASK_BUCKET_LABELS[b]}
            </button>
          ))}
        </div>
        {seesOthers ? (
          <label className="flex h-9 cursor-pointer items-center gap-2 rounded-md border border-border px-3 text-sm">
            <input
              type="checkbox"
              className="size-4 accent-primary"
              checked={mine}
              onChange={(e) => setMine(e.target.checked)}
            />
            Sólo mías
          </label>
        ) : null}
      </div>

      {tasks.error ? <ProblemAlert error={tasks.error} /> : null}

      {tasks.isLoading ? (
        <div className="grid gap-2" aria-busy="true">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-14 animate-pulse rounded-lg bg-surface-sunken" />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <div className="grid justify-items-center gap-3 rounded-lg border border-dashed border-border px-6 py-16 text-center">
          <CheckSquare className="size-8 text-fg-faint" aria-hidden />
          <p className="font-medium">
            {bucket === 'overdue'
              ? 'Nada atrasado'
              : bucket === 'today'
                ? 'Nada para hoy'
                : bucket === 'done'
                  ? 'Todavía no has completado nada'
                  : 'Nada por aquí'}
          </p>
          <p className="max-w-sm text-sm text-fg-muted">
            {bucket === 'overdue' || bucket === 'today'
              ? 'Cuando apuntes algo con fecha, aparecerá aquí el día que toque.'
              : 'Las tareas que crees aparecerán en el tramo que les corresponda.'}
          </p>
        </div>
      ) : (
        <TaskList tasks={rows} slug={slug} canWrite={can('task:write')} />
      )}
    </div>
  );
}
