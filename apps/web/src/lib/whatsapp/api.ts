import type { ChannelView, ConnectWhatsappInput } from '@nexo/contracts';
import { apiFetch } from '@/lib/api/client';

export const channelsApi = {
  list: () => apiFetch<ChannelView[]>('/channels', { auth: true }),

  connectWhatsapp: (input: ConnectWhatsappInput) =>
    apiFetch<ChannelView>('/channels/whatsapp', { method: 'POST', body: input, auth: true }),

  disconnect: (id: string) => apiFetch<void>(`/channels/${id}`, { method: 'DELETE', auth: true }),
};
