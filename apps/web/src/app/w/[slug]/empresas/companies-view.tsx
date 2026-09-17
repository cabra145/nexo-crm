'use client';

import { companyCreateSchema, type CompanyDetail } from '@nexo/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Building2, Plus, Search } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { ProblemAlert } from '@/components/auth/problem-alert';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { ApiError } from '@/lib/api/client';
import { crmApi } from '@/lib/crm/api';
import { useCompanies, useDebounced } from '@/lib/crm/hooks';
import { useAccess } from '@/lib/team/use-access';

export function CompaniesView({ slug }: { slug: string }) {
  const { can } = useAccess();
  const [search, setSearch] = useState('');
  const [creating, setCreating] = useState(false);
  const q = useDebounced(search.trim());
  const companies = useCompanies(q.length >= 2 ? q : '');

  const rows = companies.data?.data ?? [];

  return (
    <div className="mx-auto grid max-w-5xl grid-cols-[minmax(0,1fr)] gap-6 px-4 py-8 sm:px-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Empresas</h1>
          <p className="mt-1 text-sm text-fg-muted">
            Las organizaciones con las que trabajas y quién trabaja en cada una.
          </p>
        </div>
        {can('company:write') ? (
          <Button onClick={() => setCreating(true)}>
            <Plus aria-hidden />
            Nueva empresa
          </Button>
        ) : null}
      </div>

      <div className="relative max-w-sm">
        <Search
          className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-fg-faint"
          aria-hidden
        />
        <Input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Nombre de la empresa"
          aria-label="Buscar empresas"
          className="pl-9"
        />
      </div>

      {companies.error ? <ProblemAlert error={companies.error} /> : null}

      {companies.isLoading ? (
        <div className="grid gap-2 sm:grid-cols-2" aria-busy="true">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="h-20 animate-pulse rounded-lg bg-surface-sunken" />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <div className="grid justify-items-center gap-3 rounded-lg border border-dashed border-border px-6 py-16 text-center">
          <Building2 className="size-8 text-fg-faint" aria-hidden />
          <p className="font-medium">
            {q ? 'Ninguna empresa coincide' : 'Todavía no hay empresas'}
          </p>
          <p className="max-w-sm text-sm text-fg-muted">
            {q
              ? 'Prueba con otro nombre.'
              : 'Agrupa a tus contactos por la organización a la que pertenecen.'}
          </p>
          {!q && can('company:write') ? (
            <Button className="mt-1" onClick={() => setCreating(true)}>
              <Plus aria-hidden />
              Crear la primera
            </Button>
          ) : null}
        </div>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2">
          {rows.map((company) => (
            <li key={company.id}>
              <Link
                href={`/w/${slug}/empresas/${company.id}`}
                className="flex h-full flex-col gap-1 rounded-lg border border-border bg-surface p-4 hover:bg-surface-sunken"
                data-testid={`empresa-${company.id}`}
              >
                <p className="truncate font-medium">{company.name}</p>
                <p className="truncate text-sm text-fg-muted">
                  {[company.industry, company.city].filter(Boolean).join(' · ') || 'Sin datos'}
                </p>
                <p className="mt-auto pt-2 text-xs text-fg-muted">
                  {company.contactCount === 1 ? '1 contacto' : `${company.contactCount} contactos`}
                </p>
              </Link>
            </li>
          ))}
        </ul>
      )}

      {creating ? (
        <CompanyForm onClose={() => setCreating(false)} onSaved={() => setCreating(false)} />
      ) : null}
    </div>
  );
}

/** Alta y edición de una empresa. Valida con el mismo esquema que la API. */
export function CompanyForm({
  company,
  onClose,
  onSaved,
}: {
  company?: CompanyDetail;
  onClose: () => void;
  onSaved: (company: CompanyDetail) => void;
}) {
  const queryClient = useQueryClient();
  const [values, setValues] = useState({
    name: company?.name ?? '',
    industry: company?.industry ?? '',
    taxId: company?.taxId ?? '',
    website: company?.website ?? '',
    phone: company?.phone ?? '',
    email: company?.email ?? '',
    city: company?.city ?? '',
  });
  const [localErrors, setLocalErrors] = useState<Record<string, string>>({});

  const set = (key: keyof typeof values, value: string) =>
    setValues((v) => ({ ...v, [key]: value }));
  const orNull = (v: string) => (v.trim() === '' ? null : v.trim());

  const save = useMutation({
    mutationFn: async () => {
      const parsed = companyCreateSchema.safeParse({
        name: values.name.trim(),
        industry: orNull(values.industry),
        taxId: orNull(values.taxId),
        website: orNull(values.website),
        phone: orNull(values.phone),
        email: orNull(values.email),
        city: orNull(values.city),
      });
      if (!parsed.success) {
        const errors: Record<string, string> = {};
        for (const issue of parsed.error.issues) {
          errors[String(issue.path[0])] ??= issue.message;
        }
        setLocalErrors(errors);
        throw new Error('validación');
      }
      setLocalErrors({});
      return company
        ? crmApi.updateCompany(company.id, parsed.data)
        : crmApi.createCompany(parsed.data);
    },
    onSuccess: async (saved) => {
      await queryClient.invalidateQueries({ queryKey: ['crm'] });
      onSaved(saved);
    },
  });

  const fieldError = (name: string) =>
    localErrors[name] ?? (save.error instanceof ApiError ? save.error.fieldError(name) : undefined);

  return (
    <Dialog open onClose={onClose} title={company ? 'Editar empresa' : 'Nueva empresa'}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
        className="grid gap-4"
        noValidate
      >
        {save.error instanceof ApiError ? <ProblemAlert error={save.error} /> : null}
        <Field label="Nombre" error={fieldError('name')}>
          {(a) => (
            <Input
              {...a}
              autoFocus
              value={values.name}
              onChange={(e) => set('name', e.target.value)}
            />
          )}
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Sector" error={fieldError('industry')}>
            {(a) => (
              <Input
                {...a}
                value={values.industry}
                onChange={(e) => set('industry', e.target.value)}
              />
            )}
          </Field>
          <Field label="Identificación fiscal" error={fieldError('taxId')}>
            {(a) => (
              <Input {...a} value={values.taxId} onChange={(e) => set('taxId', e.target.value)} />
            )}
          </Field>
          <Field label="Sitio web" error={fieldError('website')}>
            {(a) => (
              <Input
                {...a}
                placeholder="empresa.com"
                value={values.website}
                onChange={(e) => set('website', e.target.value)}
              />
            )}
          </Field>
          <Field label="Ciudad" error={fieldError('city')}>
            {(a) => (
              <Input {...a} value={values.city} onChange={(e) => set('city', e.target.value)} />
            )}
          </Field>
          <Field label="Teléfono" hint="Con el código del país" error={fieldError('phone')}>
            {(a) => (
              <Input
                {...a}
                inputMode="tel"
                placeholder="+593…"
                value={values.phone}
                onChange={(e) => set('phone', e.target.value)}
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
        </div>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button type="submit" disabled={save.isPending || values.name.trim().length < 2}>
            {save.isPending ? 'Guardando…' : company ? 'Guardar' : 'Crear empresa'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
