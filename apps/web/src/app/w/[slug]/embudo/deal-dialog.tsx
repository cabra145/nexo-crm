'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Trophy, XCircle } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { ProblemAlert } from '@/components/auth/problem-alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { crmApi } from '@/lib/crm/api';
import { useDeal, useLostReasons } from '@/lib/crm/hooks';
import { useAccess } from '@/lib/team/use-access';
import { money } from './board-view';

const dateFormat = new Intl.DateTimeFormat('es', { day: 'numeric', month: 'short' });

/** Duración legible de un tramo del historial: «3 d», «5 h», «12 min». */
function duration(seconds: number | null): string {
  if (seconds === null) return 'en curso';
  if (seconds >= 86_400) return `${Math.round(seconds / 86_400)} d`;
  if (seconds >= 3_600) return `${Math.round(seconds / 3_600)} h`;
  return `${Math.max(1, Math.round(seconds / 60))} min`;
}

/**
 * Ficha de una oportunidad: datos, cierre (ganar o perder con motivo) y su
 * paso por las etapas con cuánto estuvo en cada una.
 */
export function DealDialog({
  dealId,
  slug,
  currency,
  onClose,
}: {
  dealId: string;
  slug: string;
  currency: string;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const { can } = useAccess();
  const deal = useDeal(dealId);
  const reasons = useLostReasons();
  const [losing, setLosing] = useState(false);
  const [reasonId, setReasonId] = useState('');
  const [note, setNote] = useState('');
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState('');
  const [value, setValue] = useState('');

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['crm'] });
  const win = useMutation({ mutationFn: () => crmApi.winDeal(dealId), onSuccess: refresh });
  const lose = useMutation({
    mutationFn: () =>
      crmApi.loseDeal(dealId, { lostReasonId: reasonId || null, note: note.trim() || null }),
    onSuccess: async () => {
      setLosing(false);
      await refresh();
    },
  });
  const save = useMutation({
    mutationFn: () => crmApi.updateDeal(dealId, { title: title.trim(), value: Number(value) || 0 }),
    onSuccess: async () => {
      setEditing(false);
      await refresh();
    },
  });
  const remove = useMutation({
    mutationFn: () => crmApi.deleteDeal(dealId),
    onSuccess: async () => {
      await refresh();
      onClose();
    },
  });

  const d = deal.data;
  const canWrite = can('deal:write');

  return (
    <Dialog open onClose={onClose} title={d?.title ?? 'Oportunidad'} className="max-w-lg">
      {deal.isLoading || !d ? (
        deal.error ? (
          <ProblemAlert error={deal.error} />
        ) : (
          <div className="h-40 animate-pulse rounded-lg bg-surface-sunken" aria-busy="true" />
        )
      ) : (
        <div className="grid gap-5">
          <ProblemAlert error={win.error ?? lose.error ?? save.error ?? remove.error} />

          <div className="flex flex-wrap items-center gap-2">
            <span className="text-2xl font-semibold">{money(d.value, d.currency || currency)}</span>
            {d.status === 'WON' ? <Badge tone="positive">Ganada</Badge> : null}
            {d.status === 'LOST' ? <Badge tone="critical">Perdida</Badge> : null}
            {d.status === 'OPEN' ? <Badge>{d.stageName}</Badge> : null}
            <span className="text-sm text-fg-muted">{d.probability}% de probabilidad</span>
          </div>

          <dl className="grid grid-cols-2 gap-3 text-sm">
            <div>
              <dt className="text-xs text-fg-faint uppercase">Contacto</dt>
              <dd className="mt-0.5">
                {d.contact ? (
                  <Link
                    href={`/w/${slug}/contactos/${d.contact.id}`}
                    className="text-primary hover:underline"
                  >
                    {d.contact.fullName}
                  </Link>
                ) : (
                  '—'
                )}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-fg-faint uppercase">Responsable</dt>
              <dd className="mt-0.5">{d.owner?.name ?? '—'}</dd>
            </div>
            {d.status === 'LOST' ? (
              <div className="col-span-2">
                <dt className="text-xs text-fg-faint uppercase">Motivo</dt>
                <dd className="mt-0.5">
                  {d.lostReason?.name ?? 'Sin motivo'}
                  {d.lostReasonNote ? ` — ${d.lostReasonNote}` : ''}
                </dd>
              </div>
            ) : null}
          </dl>

          {editing ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                save.mutate();
              }}
              className="grid gap-3 sm:grid-cols-[1fr_9rem_auto] sm:items-end"
            >
              <Field label="Título">
                {(a) => <Input {...a} value={title} onChange={(e) => setTitle(e.target.value)} />}
              </Field>
              <Field label="Valor">
                {(a) => (
                  <Input
                    {...a}
                    inputMode="decimal"
                    value={value}
                    onChange={(e) => setValue(e.target.value)}
                  />
                )}
              </Field>
              <Button type="submit" disabled={save.isPending || title.trim() === ''}>
                Guardar
              </Button>
            </form>
          ) : null}

          {losing ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                lose.mutate();
              }}
              className="grid gap-3 rounded-lg border border-border p-4"
            >
              <Field label="Motivo de la pérdida">
                {(a) => (
                  <Select {...a} value={reasonId} onChange={(e) => setReasonId(e.target.value)}>
                    <option value="">Sin especificar</option>
                    {(reasons.data ?? []).map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.name}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              <Field label="Comentario (opcional)">
                {(a) => <Input {...a} value={note} onChange={(e) => setNote(e.target.value)} />}
              </Field>
              <div className="flex gap-2">
                <Button type="submit" variant="destructive" disabled={lose.isPending}>
                  Marcar como perdida
                </Button>
                <Button type="button" variant="ghost" onClick={() => setLosing(false)}>
                  Cancelar
                </Button>
              </div>
            </form>
          ) : null}

          {canWrite && !losing && !editing ? (
            <div className="flex flex-wrap gap-2">
              {d.status === 'OPEN' ? (
                <>
                  <Button onClick={() => win.mutate()} disabled={win.isPending}>
                    <Trophy aria-hidden />
                    Ganada
                  </Button>
                  <Button variant="secondary" onClick={() => setLosing(true)}>
                    <XCircle aria-hidden />
                    Perdida
                  </Button>
                </>
              ) : null}
              <Button
                variant="ghost"
                onClick={() => {
                  setTitle(d.title);
                  setValue(String(d.value));
                  setEditing(true);
                }}
              >
                Editar
              </Button>
              {can('deal:delete') ? (
                <Button
                  variant="ghost"
                  className="text-critical"
                  disabled={remove.isPending}
                  onClick={() => remove.mutate()}
                >
                  Eliminar
                </Button>
              ) : null}
            </div>
          ) : null}

          <section className="grid gap-2">
            <h3 className="text-sm font-semibold">Recorrido</h3>
            <ol className="grid gap-1 text-sm">
              {d.history.map((step, i) => (
                <li key={`${step.stageId}-${i}`} className="flex justify-between gap-3">
                  <span>
                    {step.stageName}
                    <span className="text-fg-faint">
                      {' '}
                      · {dateFormat.format(new Date(step.enteredAt))}
                    </span>
                  </span>
                  <span className="text-fg-muted">{duration(step.durationSeconds)}</span>
                </li>
              ))}
            </ol>
          </section>
        </div>
      )}
    </Dialog>
  );
}
