'use client';

import { formatBytes, mediaKindOf, type MessageMediaView } from '@nexo/contracts';
import { useQuery } from '@tanstack/react-query';
import { AlertCircle, Download, FileText, Loader2 } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { inboxApi, inboxKeys } from '@/lib/inbox/api';

/**
 * El archivo de un mensaje.
 *
 * La URL firmada se pide sólo cuando hace falta y caduca en minutos, así que
 * se guarda algo menos de ese plazo y se vuelve a pedir sola. Un documento no
 * la pide hasta que alguien pulsa «Descargar»: no tiene sentido firmar
 * descargas que nadie va a hacer.
 */
export function MessageMedia({
  conversationId,
  media,
}: {
  conversationId: string;
  media: MessageMediaView;
}) {
  const kind = media.mimeType ? mediaKindOf(media.mimeType) : null;
  const showsItself =
    kind === 'image' || kind === 'sticker' || kind === 'audio' || kind === 'video';

  if (media.status === 'pending') {
    return (
      <p className="flex items-center gap-2 rounded-md bg-surface-sunken px-3 py-2 text-xs text-fg-muted">
        <Loader2 className="size-3.5 animate-spin" aria-hidden />
        Guardando el archivo…
      </p>
    );
  }
  if (media.status === 'failed') {
    return (
      <p className="flex items-start gap-2 rounded-md bg-critical-subtle px-3 py-2 text-xs text-critical">
        <AlertCircle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
        <span>
          No se pudo guardar el archivo
          {media.error ? `: ${media.error}` : ''}. Sigue estando en WhatsApp.
        </span>
      </p>
    );
  }

  return showsItself ? (
    <InlineMedia conversationId={conversationId} media={media} kind={kind} />
  ) : (
    <DocumentCard conversationId={conversationId} media={media} />
  );
}

/** URL firmada del archivo. `enabled` decide cuándo se pide. */
function useMediaUrl(conversationId: string, mediaId: string, enabled: boolean) {
  return useQuery({
    queryKey: inboxKeys.mediaUrl(mediaId),
    queryFn: () => inboxApi.mediaUrl(conversationId, mediaId),
    enabled,
    // Algo menos de los 5 minutos que vive la firma: se renueva antes de
    // caducar, y no se pide una por cada vez que se pinta el mensaje.
    staleTime: 4 * 60 * 1000,
    gcTime: 4 * 60 * 1000,
    retry: false,
  });
}

function InlineMedia({
  conversationId,
  media,
  kind,
}: {
  conversationId: string;
  media: MessageMediaView;
  kind: 'image' | 'sticker' | 'audio' | 'video' | null;
}) {
  const signed = useMediaUrl(conversationId, media.id, true);
  const name = media.filename ?? 'archivo';

  if (signed.isLoading) {
    return (
      <div className="h-40 w-56 animate-pulse rounded-md bg-surface-sunken" aria-busy="true" />
    );
  }
  if (signed.error || !signed.data) {
    return <DocumentCard conversationId={conversationId} media={media} />;
  }

  if (kind === 'audio') {
    // Sin subtítulos: es una nota de voz de un cliente.
    return <audio controls src={signed.data.url} className="w-64 max-w-full" aria-label={name} />;
  }
  if (kind === 'video') {
    return (
      // Sin subtítulos: es un vídeo de un cliente.
      <video
        controls
        src={signed.data.url}
        className="max-h-72 w-64 max-w-full rounded-md"
        aria-label={name}
      />
    );
  }
  return (
    <a href={signed.data.url} target="_blank" rel="noreferrer" className="block">
      {/* eslint-disable-next-line @next/next/no-img-element -- URL firmada de vida corta: el optimizador de Next no puede recogerla */}
      <img
        src={signed.data.url}
        alt={name}
        className="max-h-72 max-w-full rounded-md object-contain"
        data-testid="imagen-adjunta"
      />
    </a>
  );
}

function DocumentCard({
  conversationId,
  media,
}: {
  conversationId: string;
  media: MessageMediaView;
}) {
  // La URL no se firma hasta que alguien pulsa descargar.
  const [wanted, setWanted] = useState(false);
  const signed = useMediaUrl(conversationId, media.id, wanted);
  const name = media.filename ?? 'archivo';

  return (
    <div
      className="flex items-center gap-3 rounded-md border border-border bg-surface px-3 py-2"
      data-testid="documento-adjunto"
    >
      <FileText className="size-5 shrink-0 text-fg-muted" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="truncate text-xs font-medium">{name}</p>
        <p className="text-[11px] text-fg-faint">
          {media.sizeBytes ? formatBytes(media.sizeBytes) : ''}
        </p>
      </div>
      {signed.data ? (
        <Button asChild size="sm" variant="secondary">
          <a href={signed.data.url} download={name}>
            <Download aria-hidden />
            Guardar
          </a>
        </Button>
      ) : (
        <Button
          size="sm"
          variant="secondary"
          disabled={signed.isFetching}
          onClick={() => setWanted(true)}
        >
          {signed.isFetching ? (
            <Loader2 className="animate-spin" aria-hidden />
          ) : (
            <Download aria-hidden />
          )}
          Descargar
        </Button>
      )}
    </div>
  );
}
