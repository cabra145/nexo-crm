'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { ProblemAlert } from '@/components/auth/problem-alert';
import { StageBadge } from '@/components/crm/stage-badge';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { crmApi } from '@/lib/crm/api';
import { useCompany, useContacts } from '@/lib/crm/hooks';
import { useAccess } from '@/lib/team/use-access';
import { CompanyForm } from '../companies-view';

export function CompanyDetailView({ slug, id }: { slug: string; id: string }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { can } = useAccess();
  const company = useCompany(id);
  const contacts = useContacts({ companyId: id });
  const [editing, setEditing] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const remove = useMutation({
    mutationFn: () => crmApi.deleteCompany(id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['crm'] });
      router.replace(`/w/${slug}/empresas`);
    },
  });

  if (company.isLoading) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6" aria-busy="true">
        <div className="h-8 w-56 animate-pulse rounded bg-surface-sunken" />
        <div className="mt-6 h-48 animate-pulse rounded-lg bg-surface-sunken" />
      </div>
    );
  }
  if (company.error || !company.data) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6">
        <ProblemAlert error={company.error} />
        <Button asChild variant="secondary" className="mt-4">
          <Link href={`/w/${slug}/empresas`}>Volver a empresas</Link>
        </Button>
      </div>
    );
  }

  const c = company.data;
  const rows = contacts.data?.pages.flatMap((p) => p.data) ?? [];
  const website = c.website
    ? c.website.startsWith('http')
      ? c.website
      : `https://${c.website}`
    : null;

  return (
    <div className="mx-auto grid max-w-3xl grid-cols-[minmax(0,1fr)] gap-6 px-4 py-8 sm:px-6">
      <Link
        href={`/w/${slug}/empresas`}
        className="inline-flex w-fit items-center gap-1.5 text-sm text-fg-muted hover:text-fg"
      >
        <ArrowLeft className="size-4" aria-hidden />
        Empresas
      </Link>

      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight">{c.name}</h1>
          <p className="mt-1 text-sm text-fg-muted">
            {[c.industry, c.city, c.country].filter(Boolean).join(' · ') || 'Sin sector ni ciudad'}
          </p>
        </div>
        <div className="flex gap-2">
          {can('company:write') ? (
            <Button variant="secondary" onClick={() => setEditing(true)}>
              Editar
            </Button>
          ) : null}
          {can('company:delete') ? (
            <Button
              variant="ghost"
              aria-label="Eliminar empresa"
              onClick={() => setConfirmingDelete(true)}
            >
              <Trash2 aria-hidden />
            </Button>
          ) : null}
        </div>
      </header>

      <section className="grid gap-4 rounded-lg border border-border bg-surface p-5 sm:grid-cols-2">
        <Data label="Razón social">{c.legalName}</Data>
        <Data label="Identificación fiscal">{c.taxId}</Data>
        <Data label="Sitio web">
          {website ? (
            <a
              href={website}
              target="_blank"
              rel="noreferrer noopener"
              className="text-primary hover:underline"
            >
              {c.website}
            </a>
          ) : null}
        </Data>
        <Data label="Teléfono">{c.phone}</Data>
        <Data label="Correo">{c.email}</Data>
        <Data label="Tamaño">{c.size}</Data>
      </section>

      <section className="grid grid-cols-[minmax(0,1fr)] gap-3">
        <h2 className="text-sm font-semibold">
          Contactos {rows.length > 0 ? `(${rows.length})` : ''}
        </h2>
        {rows.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border px-4 py-8 text-center text-sm text-fg-muted">
            Ningún contacto de los que ves pertenece a esta empresa.
          </p>
        ) : (
          <ul className="divide-y divide-border rounded-lg border border-border bg-surface">
            {rows.map((contact) => (
              <li key={contact.id}>
                <Link
                  href={`/w/${slug}/contactos/${contact.id}`}
                  className="flex items-center gap-3 px-4 py-3 hover:bg-surface-sunken"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{contact.fullName}</p>
                    <p className="truncate text-xs text-fg-muted">
                      {contact.jobTitle ?? contact.email ?? ''}
                    </p>
                  </div>
                  <StageBadge stage={contact.lifecycleStage} />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      {editing ? (
        <CompanyForm
          company={c}
          onClose={() => setEditing(false)}
          onSaved={() => setEditing(false)}
        />
      ) : null}

      {confirmingDelete ? (
        <Dialog
          open
          onClose={() => setConfirmingDelete(false)}
          title={`¿Eliminar ${c.name}?`}
          description="Sus contactos NO se eliminan: se quedan sin empresa vinculada, conservando el nombre como texto."
        >
          <ProblemAlert error={remove.error} />
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setConfirmingDelete(false)}>
              Cancelar
            </Button>
            <Button
              variant="destructive"
              disabled={remove.isPending}
              onClick={() => remove.mutate()}
            >
              {remove.isPending ? 'Eliminando…' : 'Eliminar'}
            </Button>
          </div>
        </Dialog>
      ) : null}
    </div>
  );
}

function Data({ label, children }: { label: string; children?: React.ReactNode }) {
  const empty = children === null || children === undefined || children === '';
  return (
    <div className="min-w-0">
      <p className="text-xs font-medium tracking-wide text-fg-faint uppercase">{label}</p>
      <p className="mt-1 truncate text-sm">
        {empty ? <span className="text-fg-faint">—</span> : children}
      </p>
    </div>
  );
}
