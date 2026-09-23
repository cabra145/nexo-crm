'use client';

import { renderTemplate, type TemplateView } from '@nexo/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { ProblemAlert } from '@/components/auth/problem-alert';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { inboxApi, inboxKeys } from '@/lib/inbox/api';
import { cn } from '@/lib/utils';

/**
 * Enviar una plantilla: lo único que WhatsApp permite fuera de la ventana de
 * 24 h.
 *
 * El agente ve el texto REAL mientras rellena las variables, porque es lo que
 * va a llegarle al cliente y no hay manera de corregirlo después.
 */
export function TemplateDialog({
  conversationId,
  onClose,
}: {
  conversationId: string;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [chosen, setChosen] = useState<TemplateView | null>(null);
  const [values, setValues] = useState<string[]>([]);

  const templates = useQuery({
    queryKey: inboxKeys.templates(conversationId),
    queryFn: () => inboxApi.templates(conversationId),
  });

  const send = useMutation({
    mutationFn: () => inboxApi.send(conversationId, { templateId: chosen!.id, variables: values }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: inboxKeys.messages(conversationId) });
      void queryClient.invalidateQueries({ queryKey: inboxKeys.conversation(conversationId) });
      void queryClient.invalidateQueries({ queryKey: inboxKeys.lists() });
      onClose();
    },
  });

  const choose = (template: TemplateView) => {
    setChosen(template);
    setValues(Array.from({ length: template.variableCount }, () => ''));
  };
  const complete = values.every((value) => value.trim() !== '');

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (chosen && complete && !send.isPending) send.mutate();
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title="Enviar una plantilla"
      description="Pasadas 24 horas desde el último mensaje del cliente, WhatsApp sólo permite escribir con una plantilla aprobada por Meta."
      className="max-w-lg"
    >
      {templates.isLoading ? (
        <div className="h-24 animate-pulse rounded-md bg-surface-sunken" aria-busy="true" />
      ) : templates.error ? (
        <ProblemAlert error={templates.error} />
      ) : templates.data?.length === 0 ? (
        <Alert tone="warning" title="Este número no tiene plantillas aprobadas">
          Créalas en el panel de Meta y, cuando las apruebe, sincronízalas desde Ajustes → Canales.
        </Alert>
      ) : (
        <form onSubmit={submit} className="grid gap-4">
          <ProblemAlert error={send.error} />

          <ul className="grid max-h-56 gap-2 overflow-y-auto" data-testid="lista-de-plantillas">
            {templates.data?.map((template) => (
              <li key={template.id}>
                <button
                  type="button"
                  onClick={() => choose(template)}
                  data-testid={`plantilla-${template.name}`}
                  className={cn(
                    'grid w-full gap-1 rounded-md border px-3 py-2 text-left',
                    chosen?.id === template.id
                      ? 'border-primary bg-primary-subtle'
                      : 'border-border hover:bg-surface-sunken',
                  )}
                >
                  <span className="flex items-center justify-between gap-2 text-sm font-medium">
                    {template.name}
                    <span className="text-[11px] font-normal text-fg-faint uppercase">
                      {template.language} · {template.category.toLowerCase()}
                    </span>
                  </span>
                  <span className="line-clamp-2 text-xs text-fg-muted">{template.body}</span>
                </button>
              </li>
            ))}
          </ul>

          {chosen ? (
            <>
              {values.map((value, index) => (
                <Field key={index} label={`Variable ${index + 1}`}>
                  {(a) => (
                    <Input
                      {...a}
                      value={value}
                      onChange={(e) =>
                        setValues((current) =>
                          current.map((v, i) => (i === index ? e.target.value : v)),
                        )
                      }
                    />
                  )}
                </Field>
              ))}
              <div className="grid gap-1">
                <span className="text-xs font-medium text-fg-muted">
                  Lo que recibirá el cliente
                </span>
                <p
                  className="rounded-md bg-surface-sunken px-3 py-2 text-sm whitespace-pre-wrap"
                  data-testid="vista-previa-de-plantilla"
                >
                  {renderTemplate(chosen.body, values)}
                </p>
              </div>
            </>
          ) : null}

          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancelar
            </Button>
            <Button type="submit" disabled={!chosen || !complete || send.isPending}>
              {send.isPending ? 'Enviando…' : 'Enviar plantilla'}
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}
