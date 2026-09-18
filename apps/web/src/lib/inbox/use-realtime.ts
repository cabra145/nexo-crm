'use client';

import { type RealtimeEvent, realtimeEventSchema } from '@nexo/contracts';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { refreshSession } from '@/lib/auth/session';
import { useSessionStore } from '@/lib/auth/session-store';
import { publicEnv } from '@/lib/env';
import { inboxKeys } from './api';

export type RealtimeState = 'connecting' | 'live' | 'offline';

/**
 * Avisos en tiempo real de la bandeja.
 *
 * `fetch` con streaming y no `EventSource`: éste no permite enviar el token en
 * la cabecera, y ponerlo en la URL lo dejaría en logs y en el historial.
 *
 * Un aviso sólo dice QUÉ conversación cambió; aquí se invalidan sus consultas
 * y React Query vuelve a pedirlas a la API, con los permisos de siempre. Al
 * (re)conectar se invalida todo: lo que pasara durante el corte se recupera.
 *
 * La API cierra la conexión cuando caduca el token; se reconecta con el
 * renovado. Si se cae por otra causa, se reintenta con espera creciente.
 */
export function useInboxRealtime(): RealtimeState {
  const queryClient = useQueryClient();
  const [state, setState] = useState<RealtimeState>('connecting');

  useEffect(() => {
    let stopped = false;
    let controller: AbortController | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let failures = 0;

    const onEvent = (event: RealtimeEvent) => {
      void queryClient.invalidateQueries({ queryKey: inboxKeys.lists() });
      void queryClient.invalidateQueries({
        queryKey: inboxKeys.conversation(event.conversationId),
      });
      if (event.reason === 'message' || event.reason === 'delivery') {
        void queryClient.invalidateQueries({ queryKey: inboxKeys.messages(event.conversationId) });
      }
    };

    const scheduleRetry = () => {
      if (stopped) return;
      setState('offline');
      failures += 1;
      const delay = Math.min(1_000 * 2 ** Math.min(failures, 5), 30_000);
      retryTimer = setTimeout(() => void connect(), delay);
    };

    async function connect(): Promise<void> {
      if (stopped) return;
      setState((s) => (s === 'live' ? s : 'connecting'));
      let token = useSessionStore.getState().accessToken;
      controller = new AbortController();
      try {
        let response = await open(token, controller.signal);
        if (response.status === 401) {
          token = (await refreshSession())?.accessToken ?? null;
          if (!token) return;
          response = await open(token, controller.signal);
        }
        if (!response.ok || !response.body) return scheduleRetry();

        failures = 0;
        setState('live');
        // Lo que cambió mientras no había conexión.
        void queryClient.invalidateQueries({ queryKey: inboxKeys.all });

        await read(response.body, onEvent);
        // Cierre limpio: el token caducó. Se reconecta enseguida.
        if (!stopped) void connect();
      } catch {
        if (!stopped) scheduleRetry();
      }
    }

    void connect();
    return () => {
      stopped = true;
      controller?.abort();
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [queryClient]);

  return state;
}

function open(token: string | null, signal: AbortSignal): Promise<Response> {
  return fetch(`${publicEnv.NEXT_PUBLIC_API_URL}/realtime/stream`, {
    headers: {
      Accept: 'text/event-stream',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    credentials: 'include',
    cache: 'no-store',
    signal,
  });
}

async function read(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: RealtimeEvent) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buffer += decoder.decode(value, { stream: true });
    let index: number;
    while ((index = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      if (!/^event: conversation$/m.test(block)) continue;
      const data = /^data: (.*)$/m.exec(block)?.[1];
      if (!data) continue;
      const parsed = realtimeEventSchema.safeParse(JSON.parse(data));
      if (parsed.success) onEvent(parsed.data);
    }
  }
}
