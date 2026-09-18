'use client';

import { TASK_PRIORITIES, TASK_PRIORITY_LABELS, taskCreateSchema } from '@nexo/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { ProblemAlert } from '@/components/auth/problem-alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { crmApi } from '@/lib/crm/api';

/**
 * Alta rápida de tarea: una línea, sin diálogo.
 *
 * Crear una tarea tiene que costar un par de segundos; si abriera un
 * formulario grande, la gente dejaría de usarlo y apuntaría las cosas fuera.
 */
export function TaskComposer({
  contactId,
  members,
}: {
  contactId?: string;
  members?: Array<{ id: string; name: string }>;
}) {
  const queryClient = useQueryClient();
  const [title, setTitle] = useState('');
  const [dueAt, setDueAt] = useState('');
  const [priority, setPriority] = useState('MEDIUM');
  const [assigneeId, setAssigneeId] = useState('');

  const create = useMutation({
    mutationFn: () => {
      const parsed = taskCreateSchema.parse({
        title: title.trim(),
        dueAt: dueAt === '' ? null : new Date(dueAt),
        priority,
        ...(assigneeId ? { assigneeId } : {}),
        ...(contactId ? { contactId } : {}),
      });
      return crmApi.createTask(parsed);
    },
    onSuccess: async () => {
      setTitle('');
      setDueAt('');
      setPriority('MEDIUM');
      await queryClient.invalidateQueries({ queryKey: ['crm'] });
    },
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (title.trim() === '') return;
    create.mutate();
  };

  return (
    <form onSubmit={submit} className="grid gap-2" noValidate>
      <ProblemAlert error={create.error} />
      <div className="flex flex-wrap gap-2">
        <Input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="¿Qué hay que hacer?"
          aria-label="Título de la tarea"
          className="min-w-48 flex-1"
        />
        <Input
          type="datetime-local"
          value={dueAt}
          onChange={(e) => setDueAt(e.target.value)}
          aria-label="Fecha límite"
          className="w-52"
        />
        <Select
          value={priority}
          onChange={(e) => setPriority(e.target.value)}
          aria-label="Prioridad"
          className="w-36"
        >
          {TASK_PRIORITIES.map((p) => (
            <option key={p} value={p}>
              {TASK_PRIORITY_LABELS[p]}
            </option>
          ))}
        </Select>
        {members && members.length > 1 ? (
          <Select
            value={assigneeId}
            onChange={(e) => setAssigneeId(e.target.value)}
            aria-label="Responsable de la tarea"
            className="w-44"
          >
            <option value="">Para mí</option>
            {members.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </Select>
        ) : null}
        <Button type="submit" disabled={create.isPending || title.trim() === ''}>
          <Plus aria-hidden />
          Añadir
        </Button>
      </div>
    </form>
  );
}
