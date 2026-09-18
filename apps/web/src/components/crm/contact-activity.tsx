'use client';

import type { ActivityType, NoteView } from '@nexo/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Bot,
  CheckSquare,
  CircleDot,
  FileText,
  Mail,
  MessageCircle,
  Phone,
  StickyNote,
  Users,
} from 'lucide-react';
import { type ComponentType, useState } from 'react';
import { ProblemAlert } from '@/components/auth/problem-alert';
import { Button } from '@/components/ui/button';
import { crmApi } from '@/lib/crm/api';
import { useNotes, useTasks, useTimeline } from '@/lib/crm/hooks';
import { useAccess } from '@/lib/team/use-access';
import { TaskComposer } from './task-composer';
import { TaskList } from './task-list';

const dateTimeFormat = new Intl.DateTimeFormat('es', {
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
});

/**
 * Lo que pasa alrededor de un contacto: sus tareas, sus notas y su historia.
 *
 * Tres secciones y no una lista mezclada: las tareas son trabajo por hacer,
 * las notas son lo que alguien quiso dejar escrito, y la historia es el
 * registro de lo ocurrido. Mezclarlas obliga a leerlo todo para encontrar
 * cualquiera de las tres.
 */
export function ContactActivity({ contactId, slug }: { contactId: string; slug: string }) {
  const { can } = useAccess();
  const tasks = useTasks({ contactId });
  const openTasks = (tasks.data?.data ?? []).filter(
    (t) => t.status !== 'DONE' && t.status !== 'CANCELLED',
  );
  const doneTasks = (tasks.data?.data ?? []).filter(
    (t) => t.status === 'DONE' || t.status === 'CANCELLED',
  );

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-8">
      {/* --- Tareas ---------------------------------------------------------- */}
      <section className="grid grid-cols-[minmax(0,1fr)] gap-3">
        <h2 className="text-sm font-semibold">Tareas</h2>
        {can('task:write') ? <TaskComposer contactId={contactId} /> : null}
        {openTasks.length > 0 ? (
          <TaskList
            tasks={openTasks}
            slug={slug}
            showContact={false}
            canWrite={can('task:write')}
          />
        ) : (
          <p className="text-sm text-fg-muted">Nada pendiente con este contacto.</p>
        )}
        {doneTasks.length > 0 ? (
          <details className="text-sm">
            <summary className="cursor-pointer text-fg-muted hover:text-fg">
              {doneTasks.length === 1 ? '1 tarea hecha' : `${doneTasks.length} tareas hechas`}
            </summary>
            <div className="mt-2">
              <TaskList
                tasks={doneTasks}
                slug={slug}
                showContact={false}
                canWrite={can('task:write')}
              />
            </div>
          </details>
        ) : null}
      </section>

      <Notes contactId={contactId} canWrite={can('contact:write')} />
      <Timeline contactId={contactId} />
    </div>
  );
}

/* ========================================================================== */

function Notes({ contactId, canWrite }: { contactId: string; canWrite: boolean }) {
  const queryClient = useQueryClient();
  const notes = useNotes(contactId);
  const [draft, setDraft] = useState('');
  const [editing, setEditing] = useState<NoteView | null>(null);
  const [editDraft, setEditDraft] = useState('');

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['crm'] });

  const add = useMutation({
    mutationFn: () => crmApi.createNote(contactId, draft.trim()),
    onSuccess: async () => {
      setDraft('');
      await refresh();
    },
  });
  const save = useMutation({
    mutationFn: (note: NoteView) => crmApi.updateNote(note.id, editDraft.trim()),
    onSuccess: async () => {
      setEditing(null);
      await refresh();
    },
  });
  const remove = useMutation({
    mutationFn: (note: NoteView) => crmApi.deleteNote(note.id),
    onSuccess: refresh,
  });

  return (
    <section className="grid grid-cols-[minmax(0,1fr)] gap-3">
      <h2 className="text-sm font-semibold">Notas</h2>

      {canWrite ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (draft.trim() !== '') add.mutate();
          }}
          className="grid gap-2"
        >
          <ProblemAlert error={add.error} />
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={3}
            aria-label="Nueva nota"
            placeholder="Lo que conviene recordar de esta persona…"
            className="w-full rounded-md border border-border-strong bg-surface px-3 py-2 text-sm focus-visible:border-primary focus-visible:ring-3 focus-visible:ring-primary/20 focus-visible:outline-none"
          />
          <Button
            type="submit"
            size="sm"
            className="justify-self-start"
            disabled={add.isPending || draft.trim() === ''}
          >
            {add.isPending ? 'Guardando…' : 'Guardar nota'}
          </Button>
        </form>
      ) : null}

      {notes.isLoading ? (
        <div className="h-20 animate-pulse rounded-lg bg-surface-sunken" aria-busy="true" />
      ) : (notes.data ?? []).length === 0 ? (
        <p className="text-sm text-fg-muted">Todavía no hay notas.</p>
      ) : (
        <ul className="grid gap-2">
          {(notes.data ?? []).map((note) => (
            <li
              key={note.id}
              className="rounded-lg border border-border bg-surface p-3"
              data-testid={`nota-${note.id}`}
            >
              {editing?.id === note.id ? (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    save.mutate(note);
                  }}
                  className="grid gap-2"
                >
                  <ProblemAlert error={save.error} />
                  <textarea
                    value={editDraft}
                    onChange={(e) => setEditDraft(e.target.value)}
                    rows={3}
                    aria-label="Editar la nota"
                    className="w-full rounded-md border border-border-strong bg-surface px-3 py-2 text-sm"
                  />
                  <div className="flex gap-2">
                    <Button type="submit" size="sm" disabled={save.isPending}>
                      Guardar
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => setEditing(null)}
                    >
                      Cancelar
                    </Button>
                  </div>
                </form>
              ) : (
                <>
                  <p className="text-sm whitespace-pre-wrap">{note.body}</p>
                  <p className="mt-2 flex flex-wrap items-center gap-2 text-xs text-fg-muted">
                    <span>{note.author?.name ?? 'Alguien'}</span>
                    <span aria-hidden>·</span>
                    <span>{dateTimeFormat.format(new Date(note.createdAt))}</span>
                    {note.updatedAt !== note.createdAt ? <span>(editada)</span> : null}
                    {note.canEdit ? (
                      <>
                        <button
                          type="button"
                          className="underline-offset-4 hover:text-fg hover:underline"
                          onClick={() => {
                            setEditing(note);
                            setEditDraft(note.body);
                          }}
                        >
                          Editar
                        </button>
                        <button
                          type="button"
                          className="text-critical underline-offset-4 hover:underline"
                          onClick={() => remove.mutate(note)}
                        >
                          Eliminar
                        </button>
                      </>
                    ) : null}
                  </p>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      <ProblemAlert error={remove.error} />
    </section>
  );
}

const ACTIVITY_ICONS: Partial<Record<ActivityType, ComponentType<{ className?: string }>>> = {
  NOTE: StickyNote,
  TASK: CheckSquare,
  CALL: Phone,
  EMAIL: Mail,
  WHATSAPP: MessageCircle,
  MEETING: Users,
  DOCUMENT: FileText,
  AI: Bot,
};

function Timeline({ contactId }: { contactId: string }) {
  const timeline = useTimeline(contactId);

  return (
    <section className="grid grid-cols-[minmax(0,1fr)] gap-3">
      <h2 className="text-sm font-semibold">Historia</h2>
      {timeline.isLoading ? (
        <div className="h-24 animate-pulse rounded-lg bg-surface-sunken" aria-busy="true" />
      ) : (timeline.data ?? []).length === 0 ? (
        <p className="text-sm text-fg-muted">Aquí se irá guardando lo que pase con el contacto.</p>
      ) : (
        <ol className="grid gap-0">
          {(timeline.data ?? []).map((item, index, all) => {
            const Icon = ACTIVITY_ICONS[item.type] ?? CircleDot;
            const last = index === all.length - 1;
            return (
              <li key={item.id} className="flex gap-3">
                <div className="flex flex-col items-center">
                  <span className="grid size-7 shrink-0 place-items-center rounded-full bg-surface-sunken">
                    <Icon className="size-3.5 text-fg-muted" />
                  </span>
                  {!last ? <span aria-hidden className="w-px flex-1 bg-border" /> : null}
                </div>
                <div className={last ? 'pb-0' : 'pb-4'}>
                  <p className="text-sm">{item.title}</p>
                  {item.summary ? (
                    <p className="mt-0.5 text-sm text-fg-muted">{item.summary}</p>
                  ) : null}
                  <p className="mt-0.5 text-xs text-fg-faint">
                    {[item.actor?.name, dateTimeFormat.format(new Date(item.occurredAt))]
                      .filter(Boolean)
                      .join(' · ')}
                  </p>
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
