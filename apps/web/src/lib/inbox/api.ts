import type {
  ConversationDetail,
  ConversationList,
  ConversationListQuery,
  MessagePage,
  MessageView,
} from '@nexo/contracts';
import { apiFetch } from '@/lib/api/client';

const query = (params: Record<string, string | number | undefined>) => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : '';
};

export const inboxApi = {
  list: (params: Partial<ConversationListQuery>) =>
    apiFetch<ConversationList>(`/conversations${query(params)}`, { auth: true }),

  get: (id: string) => apiFetch<ConversationDetail>(`/conversations/${id}`, { auth: true }),

  messages: (id: string, before?: string) =>
    apiFetch<MessagePage>(`/conversations/${id}/messages${query({ before, limit: 50 })}`, {
      auth: true,
    }),

  send: (id: string, body: string) =>
    apiFetch<MessageView>(`/conversations/${id}/messages`, {
      method: 'POST',
      body: { body },
      auth: true,
    }),

  retry: (id: string, messageId: string) =>
    apiFetch<void>(`/conversations/${id}/messages/${messageId}/retry`, {
      method: 'POST',
      auth: true,
    }),

  read: (id: string) => apiFetch<void>(`/conversations/${id}/read`, { method: 'POST', auth: true }),

  assign: (id: string, userId: string | null) =>
    apiFetch<ConversationDetail>(`/conversations/${id}/assign`, {
      method: 'POST',
      body: { userId },
      auth: true,
    }),

  setStatus: (id: string, status: 'OPEN' | 'RESOLVED') =>
    apiFetch<ConversationDetail>(`/conversations/${id}/status`, {
      method: 'POST',
      body: { status },
      auth: true,
    }),
};

export const inboxKeys = {
  all: ['inbox'] as const,
  lists: () => ['inbox', 'list'] as const,
  conversation: (id: string) => ['inbox', 'conversation', id] as const,
  messages: (id: string) => ['inbox', 'messages', id] as const,
};
