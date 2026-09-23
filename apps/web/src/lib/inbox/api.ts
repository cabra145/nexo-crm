import type {
  ConversationDetail,
  MediaUrlView,
  ConversationList,
  ConversationListQuery,
  MessagePage,
  MessageView,
  ReserveUploadInput,
  SendMessageInput,
  UploadReservationView,
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

  send: (id: string, input: SendMessageInput) =>
    apiFetch<MessageView>(`/conversations/${id}/messages`, {
      method: 'POST',
      body: input,
      auth: true,
    }),

  /** URL firmada para ver o descargar un archivo. Caduca en minutos. */
  mediaUrl: (id: string, mediaId: string) =>
    apiFetch<MediaUrlView>(`/conversations/${id}/media/${mediaId}/url`, { auth: true }),

  reserveUpload: (id: string, input: ReserveUploadInput) =>
    apiFetch<UploadReservationView>(`/conversations/${id}/uploads`, {
      method: 'POST',
      body: input,
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

/**
 * Sube el archivo DIRECTO al almacenamiento con la URL firmada. No pasa por la
 * API, así que aquí no hay sesión: la firma es la autorización, y fija el tipo
 * y el tamaño exactos.
 *
 * XMLHttpRequest y no `fetch` por una sola razón: da el progreso de la subida,
 * y un archivo de 16 MB sin barra de progreso parece colgado.
 */
export function uploadToStorage(
  reservation: UploadReservationView,
  file: File,
  onProgress: (percent: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('PUT', reservation.url);
    for (const [name, value] of Object.entries(reservation.headers)) {
      request.setRequestHeader(name, value);
    }
    request.upload.addEventListener('progress', (event) => {
      if (event.lengthComputable) onProgress(Math.round((event.loaded / event.total) * 100));
    });
    request.addEventListener('load', () =>
      request.status >= 200 && request.status < 300
        ? resolve()
        : reject(new Error(`El almacenamiento rechazó la subida (${request.status})`)),
    );
    request.addEventListener('error', () =>
      reject(new Error('No se pudo conectar con el almacenamiento')),
    );
    request.addEventListener('abort', () => reject(new Error('Subida cancelada')));
    request.send(file);
  });
}

export const inboxKeys = {
  all: ['inbox'] as const,
  lists: () => ['inbox', 'list'] as const,
  conversation: (id: string) => ['inbox', 'conversation', id] as const,
  messages: (id: string) => ['inbox', 'messages', id] as const,
  mediaUrl: (mediaId: string) => ['inbox', 'media', mediaId] as const,
};
