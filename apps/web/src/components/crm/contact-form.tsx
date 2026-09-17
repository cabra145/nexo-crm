'use client';

import {
  contactCreateSchema,
  type ContactDetail,
  LIFECYCLE_LABELS,
  LIFECYCLE_STAGES,
  type TagView,
} from '@nexo/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ProblemAlert } from '@/components/auth/problem-alert';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { ApiError } from '@/lib/api/client';
import { crmApi } from '@/lib/crm/api';
import { useCompanies, useTags } from '@/lib/crm/hooks';

type Values = {
  firstName: string;
  lastName: string;
  jobTitle: string;
  companyId: string;
  companyName: string;
  email: string;
  phoneE164: string;
  whatsappE164: string;
  city: string;
  lifecycleStage: string;
  tagIds: string[];
};

const emptyValues: Values = {
  firstName: '',
  lastName: '',
  jobTitle: '',
  companyId: '',
  companyName: '',
  email: '',
  phoneE164: '',
  whatsappE164: '',
  city: '',
  lifecycleStage: 'LEAD',
  tagIds: [],
};

const fromContact = (c: ContactDetail): Values => ({
  firstName: c.firstName,
  lastName: c.lastName ?? '',
  jobTitle: c.jobTitle ?? '',
  companyId: c.company?.id ?? '',
  companyName: c.companyName ?? '',
  email: c.email ?? '',
  phoneE164: c.phoneE164 ?? '',
  whatsappE164: c.whatsappE164 ?? '',
  city: c.city ?? '',
  lifecycleStage: c.lifecycleStage,
  tagIds: c.tags.map((t) => t.id),
});

/** '' → null: vaciar un campo lo borra, no lo deja como cadena vacía. */
const orNull = (value: string) => (value.trim() === '' ? null : value.trim());

/**
 * Alta y edición de un contacto.
 *
 * Valida con el MISMO esquema que la API (`contactCreateSchema`), así que lo
 * que el navegador acepta es exactamente lo que la API acepta. Los errores por
 * campo que devuelve la API se pintan junto a su input.
 */
export function ContactForm({
  contact,
  onClose,
  onSaved,
}: {
  /** Ausente: alta. Presente: edición. */
  contact?: ContactDetail;
  onClose: () => void;
  onSaved: (contact: ContactDetail) => void;
}) {
  const queryClient = useQueryClient();
  const tags = useTags();
  const companies = useCompanies('');
  const [values, setValues] = useState<Values>(contact ? fromContact(contact) : emptyValues);
  const [localErrors, setLocalErrors] = useState<Record<string, string>>({});

  const set = <K extends keyof Values>(key: K, value: Values[K]) =>
    setValues((v) => ({ ...v, [key]: value }));

  const save = useMutation({
    mutationFn: async () => {
      const payload = {
        firstName: values.firstName.trim(),
        lastName: orNull(values.lastName),
        jobTitle: orNull(values.jobTitle),
        companyId: values.companyId || null,
        companyName: values.companyId ? null : orNull(values.companyName),
        email: orNull(values.email),
        phoneE164: orNull(values.phoneE164),
        whatsappE164: orNull(values.whatsappE164),
        city: orNull(values.city),
        lifecycleStage: values.lifecycleStage,
        tagIds: values.tagIds,
      };
      const parsed = contactCreateSchema.safeParse(payload);
      if (!parsed.success) {
        const errors: Record<string, string> = {};
        for (const issue of parsed.error.issues) {
          const field = String(issue.path[0]);
          errors[field] ??= issue.message;
        }
        setLocalErrors(errors);
        throw new Error('validación');
      }
      setLocalErrors({});
      return contact
        ? crmApi.updateContact(contact.id, parsed.data)
        : crmApi.createContact(parsed.data);
    },
    onSuccess: async (saved) => {
      await queryClient.invalidateQueries({ queryKey: ['crm'] });
      onSaved(saved);
    },
  });

  const fieldError = (name: keyof Values) =>
    localErrors[name] ?? (save.error instanceof ApiError ? save.error.fieldError(name) : undefined);

  return (
    <Dialog
      open
      onClose={onClose}
      title={contact ? 'Editar contacto' : 'Nuevo contacto'}
      className="max-w-lg"
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
        className="grid gap-4"
        noValidate
      >
        {save.error instanceof ApiError ? <ProblemAlert error={save.error} /> : null}

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Nombre" error={fieldError('firstName')}>
            {(a) => (
              <Input
                {...a}
                autoFocus
                value={values.firstName}
                onChange={(e) => set('firstName', e.target.value)}
              />
            )}
          </Field>
          <Field label="Apellidos" error={fieldError('lastName')}>
            {(a) => (
              <Input
                {...a}
                value={values.lastName}
                onChange={(e) => set('lastName', e.target.value)}
              />
            )}
          </Field>
          <Field label="Correo" error={fieldError('email')}>
            {(a) => (
              <Input
                {...a}
                type="email"
                value={values.email}
                onChange={(e) => set('email', e.target.value)}
              />
            )}
          </Field>
          <Field
            label="Teléfono"
            hint="Con el código del país: +593…"
            error={fieldError('phoneE164')}
          >
            {(a) => (
              <Input
                {...a}
                inputMode="tel"
                placeholder="+593987654321"
                value={values.phoneE164}
                onChange={(e) => set('phoneE164', e.target.value)}
              />
            )}
          </Field>
          <Field label="Cargo" error={fieldError('jobTitle')}>
            {(a) => (
              <Input
                {...a}
                value={values.jobTitle}
                onChange={(e) => set('jobTitle', e.target.value)}
              />
            )}
          </Field>
          <Field label="Etapa">
            {(a) => (
              <Select
                {...a}
                value={values.lifecycleStage}
                onChange={(e) => set('lifecycleStage', e.target.value)}
              >
                {LIFECYCLE_STAGES.map((stage) => (
                  <option key={stage} value={stage}>
                    {LIFECYCLE_LABELS[stage]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>

        <Field
          label="Empresa"
          hint={values.companyId ? undefined : 'Si no está en la lista, escríbela abajo.'}
          error={fieldError('companyId')}
        >
          {(a) => (
            <Select
              {...a}
              value={values.companyId}
              onChange={(e) => set('companyId', e.target.value)}
            >
              <option value="">Sin empresa del CRM</option>
              {(companies.data?.data ?? []).map((company) => (
                <option key={company.id} value={company.id}>
                  {company.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
        {!values.companyId ? (
          <Field label="Nombre de la empresa (texto libre)" error={fieldError('companyName')}>
            {(a) => (
              <Input
                {...a}
                value={values.companyName}
                onChange={(e) => set('companyName', e.target.value)}
              />
            )}
          </Field>
        ) : null}

        {(tags.data ?? []).length > 0 ? (
          <fieldset className="grid gap-2">
            <legend className="text-sm font-medium">Etiquetas</legend>
            <div className="flex flex-wrap gap-2">
              {(tags.data ?? []).map((tag: TagView) => {
                const checked = values.tagIds.includes(tag.id);
                return (
                  <label
                    key={tag.id}
                    className="flex cursor-pointer items-center gap-1.5 rounded-full border border-border px-2.5 py-1 text-xs"
                    style={checked ? { borderColor: tag.color, color: tag.color } : undefined}
                  >
                    <input
                      type="checkbox"
                      className="size-3.5 accent-primary"
                      checked={checked}
                      onChange={(e) =>
                        set(
                          'tagIds',
                          e.target.checked
                            ? [...values.tagIds, tag.id]
                            : values.tagIds.filter((id) => id !== tag.id),
                        )
                      }
                    />
                    {tag.name}
                  </label>
                );
              })}
            </div>
          </fieldset>
        ) : null}

        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button type="submit" disabled={save.isPending || values.firstName.trim() === ''}>
            {save.isPending ? 'Guardando…' : contact ? 'Guardar' : 'Crear contacto'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
