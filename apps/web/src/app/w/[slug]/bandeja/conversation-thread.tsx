'use client';

import {
  ACCEPT_ATTRIBUTE,
  checkMedia,
  type ConversationDetail,
  formatBytes,
  MEDIA_POLICY,
  type MessageView,
} from '@nexo/contracts';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertCircle,
  ArrowLeft,
  Check,
  CheckCheck,
  Clock,
  Loader2,
  Paperclip,
  RotateCcw,
  SendHorizontal,
  X,
} from 'lucide-react';
import {
  type ChangeEvent,
  type FormEvent,
  type KeyboardEvent,
  useEffect,
  useRef,
  useState,
} from 'react';
import { ProblemAlert } from '@/components/auth/problem-alert';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { useSessionStore } from '@/lib/auth/session-store';
import { inboxApi, inboxKeys, uploadToStorage } from '@/lib/inbox/api';
import { teamApi } from '@/lib/team/api';
import { useAccess } from '@/lib/team/use-access';
import { cn } from '@/lib/utils';
import { formatTime, remaining } from './format';
import { MessageMedia } from './message-media';

/** Reloj para la ventana de 24 h: se actualiza cada minuto. */
function useNow(): number | null {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    const tick = () => setNow(Date.now());
    const first = setTimeout(tick, 0);
    const timer = setInterval(tick, 60_000);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, []);
  return now;
}

export function ConversationThread({ id, onBack }: { id: string; onBack: () => void }) {
  const queryClient = useQueryClient();
  const now = useNow();
  const detail = useQuery({
    queryKey: inboxKeys.conversation(id),
    queryFn: () => inboxApi.get(id),
  });

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: inboxKeys.conversation(id) });
    void queryClient.invalidateQueries({ queryKey: inboxKeys.lists() });
  };

  // Abrirla la marca leída.
  const unread = detail.data?.unreadCount ?? 0;
  const markRead = useMutation({ mutationFn: () => inboxApi.read(id), onSuccess: refresh });
  const { mutate: read } = markRead;
  useEffect(() => {
    if (unread > 0) read();
  }, [unread, read]);

  if (detail.isLoading) {
    return <div className="m-6 h-40 animate-pulse rounded-lg bg-surface-sunken" aria-busy="true" />;
  }
  if (detail.error || !detail.data) {
    return (
      <div className="grid gap-3 p-6">
        <ProblemAlert error={detail.error} />
        <Button variant="secondary" onClick={onBack} className="justify-self-start">
          Volver a la lista
        </Button>
      </div>
    );
  }

  const conversation = detail.data;
  const windowOpen =
    now !== null &&
    conversation.windowExpiresAt !== null &&
    new Date(conversation.windowExpiresAt).getTime() > now;

  return (
    <>
      <ThreadHeader conversation={conversation} onBack={onBack} onChange={refresh} />
      <Messages id={id} />
      <Composer
        conversation={conversation}
        windowOpen={windowOpen}
        windowLeft={
          windowOpen && conversation.windowExpiresAt
            ? remaining(conversation.windowExpiresAt, now ?? undefined)
            : null
        }
        clockReady={now !== null}
      />
    </>
  );
}

/* ========================================================================== */

function ThreadHeader({
  conversation: c,
  onBack,
  onChange,
}: {
  conversation: ConversationDetail;
  onBack: () => void;
  onChange: () => void;
}) {
  const me = useSessionStore((s) => s.session?.user.id);
  const { can } = useAccess();
  const members = useQuery({
    queryKey: ['team', 'members'],
    queryFn: teamApi.members,
    enabled: c.can.assign && can('member:read'),
  });

  const assign = useMutation({
    mutationFn: (userId: string | null) => inboxApi.assign(c.id, userId),
    onSuccess: onChange,
  });
  const status = useMutation({
    mutationFn: () => inboxApi.setStatus(c.id, c.status === 'RESOLVED' ? 'OPEN' : 'RESOLVED'),
    onSuccess: onChange,
  });

  const assignable = (members.data?.members ?? []).filter((m) => m.status === 'ACTIVE');

  return (
    <header className="grid gap-2 border-b border-border px-4 py-3">
      <div className="flex flex-wrap items-center gap-3">
        <Button
          variant="ghost"
          size="icon"
          onClick={onBack}
          aria-label="Volver a la lista"
          className="md:hidden"
        >
          <ArrowLeft aria-hidden />
        </Button>
        <div className="min-w-0 flex-1">
          <h2 className="truncate font-semibold">{c.contact.name}</h2>
          <p className="truncate text-xs text-fg-muted">
            {c.contact.phone ?? 'Sin número'} · {c.channel.name}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {c.status === 'RESOLVED' ? <Badge tone="positive">Resuelta</Badge> : null}
          {c.can.assign && assignable.length > 0 ? (
            <Select
              aria-label="Asignada a"
              value={c.assignee?.id ?? ''}
              disabled={assign.isPending}
              onChange={(e) => assign.mutate(e.target.value || null)}
              className="h-7 w-44 text-xs"
            >
              <option value="">Sin asignar</option>
              {assignable.map((m) => (
                <option key={m.userId} value={m.userId}>
                  {m.userId === me ? `${m.name} (tú)` : m.name}
                </option>
              ))}
            </Select>
          ) : (
            <span className="text-xs text-fg-muted">
              {c.assignee
                ? `Lleva: ${c.assignee.id === me ? 'tú' : c.assignee.name}`
                : 'Sin asignar'}
            </span>
          )}
          {c.can.take && me ? (
            <Button size="sm" disabled={assign.isPending} onClick={() => assign.mutate(me)}>
              Tomar
            </Button>
          ) : null}
          {!c.can.assign && c.assignee?.id === me ? (
            <Button
              size="sm"
              variant="ghost"
              disabled={assign.isPending}
              onClick={() => assign.mutate(null)}
            >
              Liberar
            </Button>
          ) : null}
          {c.can.reply ? (
            <Button
              size="sm"
              variant="secondary"
              disabled={status.isPending}
              onClick={() => status.mutate()}
            >
              {c.status === 'RESOLVED' ? 'Reabrir' : 'Resolver'}
            </Button>
          ) : null}
        </div>
      </div>
      <ProblemAlert error={assign.error ?? status.error} />
    </header>
  );
}

/* ========================================================================== */

function Messages({ id }: { id: string }) {
  const scroller = useRef<HTMLDivElement>(null);
  const pages = useInfiniteQuery({
    queryKey: inboxKeys.messages(id),
    queryFn: ({ pageParam }) => inboxApi.messages(id, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => (last.hasMore ? last.data[0]?.id : undefined),
  });

  const messages = [...(pages.data?.pages ?? [])].reverse().flatMap((p) => p.data);
  const newest = messages[messages.length - 1]?.id;

  // Al llegar un mensaje nuevo (no al cargar anteriores), bajar al final.
  useEffect(() => {
    const el = scroller.current;
    if (el && newest) el.scrollTop = el.scrollHeight;
  }, [newest]);

  return (
    <div
      ref={scroller}
      className="min-h-0 flex-1 overflow-y-auto bg-surface-sunken/50 px-4 py-4"
      aria-label="Mensajes"
      role="log"
      aria-live="polite"
    >
      {pages.hasNextPage ? (
        <div className="mb-3 text-center">
          <Button
            size="sm"
            variant="ghost"
            disabled={pages.isFetchingNextPage}
            onClick={() => void pages.fetchNextPage()}
          >
            {pages.isFetchingNextPage ? 'Cargando…' : 'Ver mensajes anteriores'}
          </Button>
        </div>
      ) : null}
      {pages.isLoading ? (
        <div className="grid gap-3" aria-busy="true">
          <div className="h-10 w-2/3 animate-pulse rounded-lg bg-surface-sunken" />
          <div className="h-10 w-1/2 animate-pulse justify-self-end rounded-lg bg-surface-sunken" />
        </div>
      ) : pages.error ? (
        <ProblemAlert error={pages.error} />
      ) : (
        <ul className="grid gap-2">
          {messages.map((m) => (
            <Bubble key={m.id} conversationId={id} message={m} />
          ))}
        </ul>
      )}
    </div>
  );
}

function Bubble({ conversationId, message: m }: { conversationId: string; message: MessageView }) {
  const queryClient = useQueryClient();
  const retry = useMutation({
    mutationFn: () => inboxApi.retry(conversationId, m.id),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: inboxKeys.messages(conversationId) }),
  });
  const outbound = m.direction === 'OUTBOUND';

  return (
    <li
      className={cn('flex', outbound ? 'justify-end' : 'justify-start')}
      data-testid="mensaje"
      data-direction={outbound ? 'saliente' : 'entrante'}
      data-status={m.status}
    >
      <div
        className={cn(
          'grid max-w-[80%] gap-1 rounded-lg px-3 py-2 text-sm shadow-sm',
          outbound ? 'bg-primary-subtle' : 'bg-surface',
          m.status === 'FAILED' && 'ring-1 ring-critical',
        )}
      >
        {outbound && m.sender ? (
          <span className="text-[11px] font-medium text-fg-muted">{m.sender.name}</span>
        ) : null}
        {m.media ? <MessageMedia conversationId={conversationId} media={m.media} /> : null}
        {m.body ? (
          <p className="break-words whitespace-pre-wrap">{m.body}</p>
        ) : m.media ? null : (
          <p className="text-fg-muted italic">({m.type.toLowerCase()})</p>
        )}
        <span className="flex items-center justify-end gap-1 text-[11px] text-fg-faint">
          {formatTime(m.createdAt)}
          {outbound ? <DeliveryIcon status={m.status} /> : null}
        </span>
        {m.status === 'FAILED' ? (
          <div className="flex flex-wrap items-center gap-2 text-xs text-critical">
            <span>No se envió{m.errorMessage ? `: ${m.errorMessage}` : ''}</span>
            <Button
              size="sm"
              variant="ghost"
              disabled={retry.isPending}
              onClick={() => retry.mutate()}
            >
              <RotateCcw aria-hidden />
              Reintentar
            </Button>
          </div>
        ) : null}
        {retry.error ? <ProblemAlert error={retry.error} /> : null}
      </div>
    </li>
  );
}

function DeliveryIcon({ status }: { status: MessageView['status'] }) {
  switch (status) {
    case 'QUEUED':
      return <Clock className="size-3" aria-label="Enviando" />;
    case 'SENT':
      return <Check className="size-3" aria-label="Enviado" />;
    case 'DELIVERED':
      return <CheckCheck className="size-3" aria-label="Entregado" />;
    case 'READ':
      return <CheckCheck className="size-3 text-primary" aria-label="Leído" />;
    case 'FAILED':
      return <AlertCircle className="size-3 text-critical" aria-label="No enviado" />;
  }
}

/* ========================================================================== */

function Composer({
  conversation: c,
  windowOpen,
  windowLeft,
  clockReady,
}: {
  conversation: ConversationDetail;
  windowOpen: boolean;
  windowLeft: string | null;
  clockReady: boolean;
}) {
  const queryClient = useQueryClient();
  const [text, setText] = useState('');
  const [attachment, setAttachment] = useState<File | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const refresh = () => {
    setText('');
    setAttachment(null);
    setProgress(null);
    void queryClient.invalidateQueries({ queryKey: inboxKeys.messages(c.id) });
    void queryClient.invalidateQueries({ queryKey: inboxKeys.conversation(c.id) });
    void queryClient.invalidateQueries({ queryKey: inboxKeys.lists() });
  };

  const send = useMutation({
    mutationFn: async ({ body, file }: { body: string; file: File | null }) => {
      if (!file) return inboxApi.send(c.id, { body });
      // Tres pasos: reservar, subir DIRECTO al almacenamiento y enviar.
      const reservation = await inboxApi.reserveUpload(c.id, {
        filename: file.name,
        mimeType: file.type,
        sizeBytes: file.size,
      });
      setProgress(0);
      await uploadToStorage(reservation, file, setProgress);
      return inboxApi.send(c.id, { fileId: reservation.fileId, ...(body ? { body } : {}) });
    },
    onSuccess: refresh,
    onError: () => setProgress(null),
  });

  /** Se valida aquí lo mismo que valida la API, para avisar antes de subir. */
  const chooseFile = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0] ?? null;
    event.target.value = '';
    if (!file) return;
    const check = checkMedia({ mime: file.type, sizeBytes: file.size });
    if (!check.ok) {
      setFileError(check.reason);
      setAttachment(null);
      return;
    }
    setFileError(null);
    setAttachment(file);
  };

  if (!c.can.reply) {
    return (
      <p className="border-t border-border px-4 py-3 text-sm text-fg-muted">
        Sólo puede responder quien lleva esta conversación.
      </p>
    );
  }
  if (!c.channelConnected) {
    return (
      <div className="border-t border-border p-4">
        <Alert tone="warning" title="El número está desconectado">
          Vuelve a conectarlo en Ajustes → Canales para responder.
        </Alert>
      </div>
    );
  }
  if (clockReady && !windowOpen) {
    return (
      <div className="border-t border-border p-4">
        <Alert tone="warning" title="Pasaron más de 24 horas desde su último mensaje">
          WhatsApp sólo permite responder con texto libre durante las 24 horas siguientes al último
          mensaje del cliente. Para escribirle ahora hace falta una plantilla aprobada por Meta.
        </Alert>
      </div>
    );
  }

  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    const body = text.trim();
    if ((body || attachment) && !send.isPending) send.mutate({ body, file: attachment });
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // Intro envía; Mayús+Intro, salto de línea.
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      submit();
    }
  };

  const maxDocument = formatBytes(MEDIA_POLICY.document.maxBytes);

  return (
    <form onSubmit={submit} className="grid gap-2 border-t border-border p-3">
      <ProblemAlert error={send.error} />
      {fileError ? (
        <p role="alert" className="text-xs text-critical">
          {fileError}
        </p>
      ) : null}

      {attachment ? (
        <div
          className="flex items-center gap-2 rounded-md bg-surface-sunken px-3 py-2 text-xs"
          data-testid="adjunto-pendiente"
        >
          {send.isPending ? (
            <Loader2 className="size-3.5 animate-spin text-fg-muted" aria-hidden />
          ) : (
            <Paperclip className="size-3.5 text-fg-muted" aria-hidden />
          )}
          <span className="min-w-0 flex-1 truncate">{attachment.name}</span>
          <span className="shrink-0 text-fg-faint">
            {progress !== null && send.isPending
              ? `Subiendo… ${progress}%`
              : formatBytes(attachment.size)}
          </span>
          {!send.isPending ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              aria-label="Quitar el adjunto"
              onClick={() => setAttachment(null)}
            >
              <X aria-hidden />
            </Button>
          ) : null}
        </div>
      ) : null}

      <div className="flex items-end gap-2">
        <input
          ref={fileInput}
          type="file"
          accept={ACCEPT_ATTRIBUTE}
          onChange={chooseFile}
          className="hidden"
          data-testid="selector-de-archivo"
        />
        <Button
          type="button"
          variant="ghost"
          aria-label="Adjuntar un archivo"
          title={`Imágenes, audio, vídeo y documentos (hasta ${maxDocument})`}
          disabled={send.isPending}
          onClick={() => fileInput.current?.click()}
        >
          <Paperclip aria-hidden />
        </Button>
        <textarea
          aria-label="Mensaje"
          placeholder={attachment ? 'Añade un texto (opcional)…' : 'Escribe una respuesta…'}
          rows={2}
          value={text}
          maxLength={4096}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          className="min-h-10 flex-1 resize-none rounded-md border border-border bg-surface px-3 py-2 text-sm focus-visible:ring-2 focus-visible:ring-primary focus-visible:outline-none"
        />
        <Button
          type="submit"
          disabled={(!text.trim() && !attachment) || send.isPending}
          aria-label="Enviar"
        >
          <SendHorizontal aria-hidden />
        </Button>
      </div>
      {windowLeft ? (
        <p className="text-[11px] text-fg-faint">
          Ventana de respuesta abierta: quedan {windowLeft}.
        </p>
      ) : null}
    </form>
  );
}
