'use client';

import { type ChannelView, connectWhatsappSchema } from '@nexo/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Copy, FileText, MessageCircle, Plus, RefreshCw } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { PasswordInput } from '@/components/auth/password-field';
import { ProblemAlert } from '@/components/auth/problem-alert';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { ApiError } from '@/lib/api/client';
import { channelsApi } from '@/lib/whatsapp/api';

const STATUS: Record<
  ChannelView['status'],
  { label: string; tone: 'positive' | 'warning' | 'critical' | 'neutral' }
> = {
  CONNECTED: { label: 'Conectado', tone: 'positive' },
  PENDING: { label: 'Pendiente', tone: 'warning' },
  ERROR: { label: 'Con errores', tone: 'critical' },
  DISABLED: { label: 'Desconectado', tone: 'neutral' },
};

/**
 * Canales de mensajería de la empresa: por ahora, WhatsApp Business.
 *
 * Tras conectar, la pantalla muestra lo único que la empresa tiene que llevar
 * a Meta —la URL del webhook y su token de verificación— con botones de
 * copiar y los pasos, porque ese es el punto donde más fácil es equivocarse.
 */
export function ChannelsSettings() {
  const queryClient = useQueryClient();
  const channels = useQuery({ queryKey: ['channels'], queryFn: channelsApi.list });
  const [connecting, setConnecting] = useState(false);
  const [removing, setRemoving] = useState<ChannelView | null>(null);

  const disconnect = useMutation({
    mutationFn: (id: string) => channelsApi.disconnect(id),
    onSuccess: async () => {
      setRemoving(null);
      await queryClient.invalidateQueries({ queryKey: ['channels'] });
    },
  });

  if (channels.isLoading) {
    return <div className="h-48 animate-pulse rounded-lg bg-surface-sunken" aria-busy="true" />;
  }
  if (channels.error || !channels.data) return <ProblemAlert error={channels.error} />;

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold">Canales</h2>
          <p className="mt-1 text-sm text-fg-muted">
            Conecta el número de WhatsApp Business de tu empresa para atender a tus clientes desde
            Nexo.
          </p>
        </div>
        <Button onClick={() => setConnecting(true)}>
          <Plus aria-hidden />
          Conectar WhatsApp
        </Button>
      </div>

      {channels.data.length === 0 ? (
        <div className="grid justify-items-center gap-3 rounded-lg border border-dashed border-border px-6 py-14 text-center">
          <MessageCircle className="size-8 text-fg-faint" aria-hidden />
          <p className="font-medium">Todavía no hay ningún número conectado</p>
          <p className="max-w-md text-sm text-fg-muted">
            Necesitas una app de Meta con el producto WhatsApp y un número de WhatsApp Business.
            Tendrás a mano sus identificadores, un token de acceso y la clave secreta de la app.
          </p>
        </div>
      ) : (
        <ul className="grid gap-4">
          {channels.data.map((channel) => (
            <ChannelCard
              key={channel.id}
              channel={channel}
              onDisconnect={() => setRemoving(channel)}
            />
          ))}
        </ul>
      )}

      {connecting ? <ConnectDialog onClose={() => setConnecting(false)} /> : null}

      {removing ? (
        <Dialog
          open
          onClose={() => setRemoving(null)}
          title={`¿Desconectar ${removing.displayId ?? removing.name}?`}
          description="Dejarás de recibir sus mensajes en Nexo. Las conversaciones que ya tienes se conservan."
        >
          <ProblemAlert error={disconnect.error} />
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setRemoving(null)}>
              Cancelar
            </Button>
            <Button
              variant="destructive"
              disabled={disconnect.isPending}
              onClick={() => disconnect.mutate(removing.id)}
            >
              Desconectar
            </Button>
          </div>
        </Dialog>
      ) : null}
    </div>
  );
}

function ChannelCard({
  channel,
  onDisconnect,
}: {
  channel: ChannelView;
  onDisconnect: () => void;
}) {
  const status = STATUS[channel.status];
  return (
    <li
      className="grid gap-4 rounded-lg border border-border bg-surface p-5"
      data-testid={`canal-${channel.displayId ?? channel.id}`}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <span className="grid size-10 place-items-center rounded-full bg-positive-subtle">
            <MessageCircle className="size-5 text-positive" aria-hidden />
          </span>
          <div>
            <p className="font-medium">
              {channel.displayId ?? 'Número pendiente'}{' '}
              <span className="font-normal text-fg-muted">· {channel.name}</span>
            </p>
            <p className="text-sm text-fg-muted">
              {channel.verifiedName ? `${channel.verifiedName} en WhatsApp` : 'WhatsApp Business'}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Badge tone={status.tone}>{status.label}</Badge>
          <Button size="sm" variant="ghost" onClick={onDisconnect}>
            Desconectar
          </Button>
        </div>
      </div>

      {channel.lastErrorMessage ? (
        <Alert tone="critical" title="Último error del canal">
          {channel.lastErrorMessage}
        </Alert>
      ) : null}

      <Templates channelId={channel.id} />

      <div className="grid gap-3 rounded-md bg-surface-sunken p-4">
        <p className="text-sm font-medium">Último paso: configura el webhook en Meta</p>
        <ol className="grid gap-1 text-sm text-fg-muted">
          <li>
            1. En tu app de Meta, abre <strong className="text-fg">WhatsApp → Configuración</strong>
            .
          </li>
          <li>2. En «Webhook», pega la URL y el token de verificación de aquí debajo.</li>
          <li>
            3. Suscríbete al campo <strong className="text-fg">messages</strong>.
          </li>
        </ol>
        <CopyField label="URL del webhook" value={channel.webhookUrl} />
        <CopyField label="Token de verificación" value={channel.verifyToken} secret />
      </div>
    </li>
  );
}

/**
 * Plantillas del canal. Se crean en el panel de Meta, que las aprueba; aquí
 * sólo se sincronizan para poder enviarlas fuera de la ventana de 24 h.
 */
function Templates({ channelId }: { channelId: string }) {
  const queryClient = useQueryClient();
  const templates = useQuery({
    queryKey: ['channels', channelId, 'templates'],
    queryFn: () => channelsApi.templates(channelId),
  });
  const sync = useMutation({
    mutationFn: () => channelsApi.syncTemplates(channelId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['channels', channelId, 'templates'] });
    },
  });

  const list = templates.data ?? [];
  const sendable = list.filter((t) => t.sendable).length;

  return (
    <div className="grid gap-2 rounded-md border border-border p-4" data-testid="plantillas">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <FileText className="size-4 text-fg-muted" aria-hidden />
          <p className="text-sm font-medium">Plantillas</p>
        </div>
        <Button
          size="sm"
          variant="secondary"
          disabled={sync.isPending}
          onClick={() => sync.mutate()}
        >
          <RefreshCw className={sync.isPending ? 'animate-spin' : undefined} aria-hidden />
          {sync.isPending ? 'Sincronizando…' : 'Sincronizar con Meta'}
        </Button>
      </div>
      <p className="text-sm text-fg-muted">
        {templates.isLoading
          ? 'Cargando…'
          : list.length === 0
            ? 'Ninguna todavía. Créalas en el panel de Meta y sincroniza.'
            : `${list.length} en total · ${sendable} lista(s) para enviar.`}
      </p>
      {list
        .filter((t) => !t.sendable)
        .slice(0, 3)
        .map((t) => (
          <p key={t.id} className="text-xs text-fg-faint">
            <span className="font-medium">{t.name}</span> ({t.language}): {t.blockedReason}
            {t.rejectedReason ? ` — ${t.rejectedReason}` : ''}
          </p>
        ))}
      <ProblemAlert error={sync.error} />
    </div>
  );
}

function CopyField({
  label,
  value,
  secret = false,
}: {
  label: string;
  value: string;
  secret?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const [shown, setShown] = useState(!secret);
  return (
    <div className="grid gap-1">
      <span className="text-xs font-medium text-fg-muted">{label}</span>
      <div className="flex gap-2">
        <code
          className="min-w-0 flex-1 truncate rounded-md border border-border bg-surface px-3 py-2 font-mono text-xs"
          data-testid={label}
        >
          {shown ? value : '•'.repeat(24)}
        </code>
        {secret ? (
          <Button size="sm" variant="ghost" onClick={() => setShown((v) => !v)}>
            {shown ? 'Ocultar' : 'Mostrar'}
          </Button>
        ) : null}
        <Button
          size="sm"
          variant="secondary"
          aria-label={`Copiar ${label.toLowerCase()}`}
          onClick={() =>
            void navigator.clipboard.writeText(value).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            })
          }
        >
          {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
          {copied ? 'Copiado' : 'Copiar'}
        </Button>
      </div>
    </div>
  );
}

function ConnectDialog({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();
  const [values, setValues] = useState({
    name: 'WhatsApp',
    phoneNumberId: '',
    wabaId: '',
    accessToken: '',
    appSecret: '',
  });
  const [localErrors, setLocalErrors] = useState<Record<string, string>>({});
  const set = (key: keyof typeof values, value: string) =>
    setValues((v) => ({ ...v, [key]: value }));

  const connect = useMutation({
    mutationFn: () => {
      const parsed = connectWhatsappSchema.safeParse(values);
      if (!parsed.success) {
        const errors: Record<string, string> = {};
        for (const issue of parsed.error.issues) errors[String(issue.path[0])] ??= issue.message;
        setLocalErrors(errors);
        throw new Error('validación');
      }
      setLocalErrors({});
      return channelsApi.connectWhatsapp(parsed.data);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['channels'] });
      onClose();
    },
  });

  const fieldError = (name: string) =>
    localErrors[name] ??
    (connect.error instanceof ApiError ? connect.error.fieldError(name) : undefined);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    connect.mutate();
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title="Conectar WhatsApp Business"
      description="Estos datos están en tu app de Meta. Nexo comprueba con Meta que son correctos antes de guardarlos, y los guarda cifrados."
      className="max-w-lg"
    >
      <form onSubmit={submit} className="grid gap-4" noValidate>
        {connect.error instanceof ApiError ? <ProblemAlert error={connect.error} /> : null}
        <Field
          label="Nombre del canal"
          hint="Para distinguirlo si conectas más de uno."
          error={fieldError('name')}
        >
          {(a) => (
            <Input {...a} value={values.name} onChange={(e) => set('name', e.target.value)} />
          )}
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Identificador del número"
            hint="WhatsApp → Configuración de la API"
            error={fieldError('phoneNumberId')}
          >
            {(a) => (
              <Input
                {...a}
                inputMode="numeric"
                value={values.phoneNumberId}
                onChange={(e) => set('phoneNumberId', e.target.value)}
              />
            )}
          </Field>
          <Field
            label="Identificador de la cuenta"
            hint="Cuenta de WhatsApp Business"
            error={fieldError('wabaId')}
          >
            {(a) => (
              <Input
                {...a}
                inputMode="numeric"
                value={values.wabaId}
                onChange={(e) => set('wabaId', e.target.value)}
              />
            )}
          </Field>
        </div>
        <Field
          label="Token de acceso"
          hint="De un usuario del sistema, con el permiso whatsapp_business_messaging. No uses el token temporal de 24 h."
          error={fieldError('accessToken')}
        >
          {(a) => (
            <PasswordInput
              {...a}
              autoComplete="off"
              value={values.accessToken}
              onChange={(e) => set('accessToken', e.target.value)}
            />
          )}
        </Field>
        <Field
          label="Clave secreta de la app"
          hint="Configuración de la app → Básica. Sirve para comprobar que los mensajes vienen de Meta."
          error={fieldError('appSecret')}
        >
          {(a) => (
            <PasswordInput
              {...a}
              autoComplete="off"
              value={values.appSecret}
              onChange={(e) => set('appSecret', e.target.value)}
            />
          )}
        </Field>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button type="submit" disabled={connect.isPending}>
            {connect.isPending ? 'Comprobando con Meta…' : 'Conectar'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
