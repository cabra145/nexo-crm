'use client';

import { dealCreateSchema, type StageView } from '@nexo/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { ProblemAlert } from '@/components/auth/problem-alert';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { ApiError } from '@/lib/api/client';
import { crmApi } from '@/lib/crm/api';

/** Alta de oportunidad. Valida con el mismo esquema que la API. */
export function NewDealDialog({
  stages,
  pipelineId,
  onClose,
}: {
  stages: StageView[];
  pipelineId: string;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [title, setTitle] = useState('');
  const [value, setValue] = useState('');
  const [stageId, setStageId] = useState(stages[0]?.id ?? '');
  const [contactId, setContactId] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);
  // Los contactos que la sesión puede ver: la API aplica el alcance del rol.
  const contacts = useQuery({
    queryKey: ['crm', 'contacts-for-deal'],
    queryFn: () => crmApi.contacts({ limit: 100 }),
  });

  const create = useMutation({
    mutationFn: () => {
      const parsed = dealCreateSchema.safeParse({
        title: title.trim(),
        value: value === '' ? 0 : value,
        pipelineId,
        stageId,
        contactId: contactId || null,
      });
      if (!parsed.success) {
        setLocalError(parsed.error.issues[0]?.message ?? 'revisa los datos');
        throw new Error('validación');
      }
      setLocalError(null);
      return crmApi.createDeal(parsed.data);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['crm'] });
      onClose();
    },
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    create.mutate();
  };

  return (
    <Dialog open onClose={onClose} title="Nueva oportunidad">
      <form onSubmit={submit} className="grid gap-4" noValidate>
        {create.error instanceof ApiError ? <ProblemAlert error={create.error} /> : null}
        <Field label="¿Qué se vende?" error={localError ?? undefined}>
          {(a) => (
            <Input
              {...a}
              autoFocus
              placeholder="50 cajas de tornillos para Ferretería Norte"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          )}
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Valor">
            {(a) => (
              <Input
                {...a}
                inputMode="decimal"
                placeholder="0"
                value={value}
                onChange={(e) => setValue(e.target.value)}
              />
            )}
          </Field>
          <Field label="Etapa">
            {(a) => (
              <Select {...a} value={stageId} onChange={(e) => setStageId(e.target.value)}>
                {stages.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>
        <Field label="Contacto (opcional)">
          {(a) => (
            <Select {...a} value={contactId} onChange={(e) => setContactId(e.target.value)}>
              <option value="">Sin contacto</option>
              {(contacts.data?.data ?? []).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.fullName}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button type="submit" disabled={create.isPending || title.trim() === ''}>
            {create.isPending ? 'Creando…' : 'Crear oportunidad'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
