import type {
  ChannelView,
  ConnectWhatsappInput,
  TemplateSyncResult,
  TemplateView,
} from '@nexo/contracts';
import { apiFetch } from '@/lib/api/client';

export const channelsApi = {
  list: () => apiFetch<ChannelView[]>('/channels', { auth: true }),

  connectWhatsapp: (input: ConnectWhatsappInput) =>
    apiFetch<ChannelView>('/channels/whatsapp', { method: 'POST', body: input, auth: true }),

  disconnect: (id: string) => apiFetch<void>(`/channels/${id}`, { method: 'DELETE', auth: true }),

  templates: (id: string) => apiFetch<TemplateView[]>(`/channels/${id}/templates`, { auth: true }),

  syncTemplates: (id: string) =>
    apiFetch<TemplateSyncResult>(`/channels/${id}/templates/sync`, { method: 'POST', auth: true }),
};
