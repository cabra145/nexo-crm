'use client';

import type { ConversationSummary, InboxView as InboxTab } from '@nexo/contracts';
import { useQuery } from '@tanstack/react-query';
import { MessageCircle, Search } from 'lucide-react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { ProblemAlert } from '@/components/auth/problem-alert';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { inboxApi, inboxKeys } from '@/lib/inbox/api';
import { type RealtimeState, useInboxRealtime } from '@/lib/inbox/use-realtime';
import { cn } from '@/lib/utils';
import { ConversationThread } from './conversation-thread';
import { formatWhen } from './format';

const TABS: Array<{ key: InboxTab; label: string }> = [
  { key: 'mine', label: 'Mías' },
  { key: 'unassigned', label: 'Sin asignar' },
  { key: 'all', label: 'Todas' },
];

/**
 * Bandeja de entrada: lista a la izquierda, conversación a la derecha. En
 * móvil, una u otra. La conversación abierta va en la URL (`?c=`), así que se
 * puede compartir el enlace y el botón «atrás» vuelve a la lista.
 */
export function InboxView() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const selected = params.get('c');
  const realtime = useInboxRealtime();

  const [tab, setTab] = useState<InboxTab>('all');
  const [state, setState] = useState<'open' | 'resolved'>('open');
  const [q, setQ] = useState('');

  const list = useQuery({
    queryKey: [...inboxKeys.lists(), tab, state, q],
    queryFn: () => inboxApi.list({ view: tab, state, q: q.trim() || undefined }),
    placeholderData: (previous) => previous,
  });

  const open = (id: string | null) => {
    const next = new URLSearchParams(params);
    if (id) next.set('c', id);
    else next.delete('c');
    router.push(`${pathname}${next.size ? `?${next}` : ''}`, { scroll: false });
  };

  return (
    <div className="flex h-[calc(100dvh-3.5rem)] min-h-0">
      <section
        aria-label="Conversaciones"
        className={cn(
          'flex min-h-0 w-full flex-col border-r border-border md:w-80 lg:w-96',
          selected ? 'hidden md:flex' : 'flex',
        )}
      >
        <div className="grid gap-3 border-b border-border p-4">
          <div className="flex items-center justify-between">
            <h1 className="text-lg font-semibold">Bandeja</h1>
            <LiveIndicator state={realtime} />
          </div>
          <div role="tablist" aria-label="Vista" className="grid grid-cols-3 gap-1">
            {TABS.map((t) => {
              const unread = list.data?.unread[t.key] ?? 0;
              return (
                <button
                  key={t.key}
                  type="button"
                  role="tab"
                  aria-selected={tab === t.key}
                  onClick={() => setTab(t.key)}
                  className={cn(
                    'flex items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium transition-colors',
                    tab === t.key
                      ? 'bg-primary-subtle text-primary'
                      : 'text-fg-muted hover:bg-surface-sunken',
                  )}
                >
                  {t.label}
                  {unread > 0 ? (
                    <span className="rounded-full bg-primary px-1.5 text-[10px] leading-4 text-fg-on-primary">
                      {unread}
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>
          <div className="flex gap-2">
            <div className="relative min-w-0 flex-1">
              <Search
                className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-fg-faint"
                aria-hidden
              />
              <Input
                aria-label="Buscar por nombre o número"
                placeholder="Buscar"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                className="pl-8"
              />
            </div>
            <Select
              aria-label="Estado"
              value={state}
              onChange={(e) => setState(e.target.value as 'open' | 'resolved')}
              className="w-32"
            >
              <option value="open">Abiertas</option>
              <option value="resolved">Resueltas</option>
            </Select>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {list.isLoading ? (
            <div className="grid gap-2 p-4" aria-busy="true">
              {[0, 1, 2].map((i) => (
                <div key={i} className="h-14 animate-pulse rounded-md bg-surface-sunken" />
              ))}
            </div>
          ) : list.error ? (
            <div className="p-4">
              <ProblemAlert error={list.error} />
            </div>
          ) : list.data?.data.length === 0 ? (
            <EmptyList tab={tab} searching={Boolean(q.trim())} />
          ) : (
            <ul>
              {list.data?.data.map((c) => (
                <ConversationItem
                  key={c.id}
                  conversation={c}
                  active={c.id === selected}
                  onOpen={() => open(c.id)}
                />
              ))}
            </ul>
          )}
        </div>
      </section>

      <section
        aria-label="Conversación"
        className={cn('min-h-0 min-w-0 flex-1 flex-col', selected ? 'flex' : 'hidden md:flex')}
      >
        {selected ? (
          <ConversationThread key={selected} id={selected} onBack={() => open(null)} />
        ) : (
          <div className="grid flex-1 place-items-center p-6 text-center">
            <div className="grid justify-items-center gap-2">
              <MessageCircle className="size-8 text-fg-faint" aria-hidden />
              <p className="text-sm text-fg-muted">Elige una conversación para verla aquí.</p>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

function ConversationItem({
  conversation: c,
  active,
  onOpen,
}: {
  conversation: ConversationSummary;
  active: boolean;
  onOpen: () => void;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        aria-current={active ? 'true' : undefined}
        data-testid={`conversacion-${c.contact.phone ?? c.id}`}
        className={cn(
          'grid w-full gap-0.5 border-b border-border px-4 py-3 text-left transition-colors',
          active ? 'bg-primary-subtle' : 'hover:bg-surface-sunken',
        )}
      >
        <span className="flex items-center justify-between gap-2">
          <span className={cn('truncate text-sm', c.unreadCount > 0 && 'font-semibold')}>
            {c.contact.name}
          </span>
          <span className="shrink-0 text-xs text-fg-faint">
            {c.lastMessageAt ? formatWhen(c.lastMessageAt) : ''}
          </span>
        </span>
        <span className="flex items-center justify-between gap-2">
          <span className="truncate text-xs text-fg-muted">
            {c.lastMessageDirection === 'OUTBOUND' ? 'Tú: ' : ''}
            {c.lastMessagePreview ?? ''}
          </span>
          {c.unreadCount > 0 ? (
            <span
              className="shrink-0 rounded-full bg-positive px-1.5 text-[10px] leading-4 font-semibold text-fg-on-primary"
              aria-label={`${c.unreadCount} sin leer`}
            >
              {c.unreadCount}
            </span>
          ) : null}
        </span>
        <span className="truncate text-[11px] text-fg-faint">
          {c.assignee ? `Lleva: ${c.assignee.name}` : 'Sin asignar'}
        </span>
      </button>
    </li>
  );
}

function EmptyList({ tab, searching }: { tab: InboxTab; searching: boolean }) {
  const text = searching
    ? 'Nada coincide con la búsqueda.'
    : tab === 'mine'
      ? 'No tienes conversaciones asignadas.'
      : tab === 'unassigned'
        ? 'No hay conversaciones esperando a que alguien las tome.'
        : 'Aún no hay conversaciones. Llegarán aquí cuando tus clientes escriban a tu WhatsApp.';
  return <p className="px-4 py-10 text-center text-sm text-fg-muted">{text}</p>;
}

function LiveIndicator({ state }: { state: RealtimeState }) {
  const label =
    state === 'live' ? 'En vivo' : state === 'connecting' ? 'Conectando…' : 'Reconectando…';
  return (
    <span className="flex items-center gap-1.5 text-xs text-fg-muted" role="status">
      <span
        className={cn(
          'size-2 rounded-full',
          state === 'live' ? 'bg-positive' : 'animate-pulse bg-warning',
        )}
        aria-hidden
      />
      {label}
    </span>
  );
}
