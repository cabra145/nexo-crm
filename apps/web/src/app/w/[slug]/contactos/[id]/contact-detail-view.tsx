'use client';

import type { ContactDetail } from '@nexo/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Building2, Mail, MessageCircle, Phone, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { type ReactNode, useState } from 'react';
import { ProblemAlert } from '@/components/auth/problem-alert';
import { ContactForm } from '@/components/crm/contact-form';
import { StageBadge } from '@/components/crm/stage-badge';
import { TagChips } from '@/components/crm/tag-chips';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { crmApi } from '@/lib/crm/api';
import { useContact } from '@/lib/crm/hooks';
import { useAccess } from '@/lib/team/use-access';

const dateFormat = new Intl.DateTimeFormat('es', { dateStyle: 'long' });

export function ContactDetailView({ slug, id }: { slug: string; id: string }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { can } = useAccess();
  const contact = useContact(id);
  const [editing, setEditing] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const remove = useMutation({
    mutationFn: () => crmApi.deleteContact(id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['crm'] });
      router.replace(`/w/${slug}/contactos`);
    },
  });

  if (contact.isLoading) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6" aria-busy="true">
        <div className="h-8 w-56 animate-pulse rounded bg-surface-sunken" />
        <div className="mt-6 h-64 animate-pulse rounded-lg bg-surface-sunken" />
      </div>
    );
  }
  if (contact.error || !contact.data) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6">
        <ProblemAlert error={contact.error} />
        <Button asChild variant="secondary" className="mt-4">
          <Link href={`/w/${slug}/contactos`}>Volver a contactos</Link>
        </Button>
      </div>
    );
  }

  const c: ContactDetail = contact.data;

  return (
    <div className="mx-auto grid max-w-3xl grid-cols-[minmax(0,1fr)] gap-6 px-4 py-8 sm:px-6">
      <Link
        href={`/w/${slug}/contactos`}
        className="inline-flex w-fit items-center gap-1.5 text-sm text-fg-muted hover:text-fg"
      >
        <ArrowLeft className="size-4" aria-hidden />
        Contactos
      </Link>

      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight">{c.fullName}</h1>
          <p className="mt-1 text-sm text-fg-muted">
            {[c.jobTitle, c.company?.name ?? c.companyName].filter(Boolean).join(' · ') ||
              'Sin cargo ni empresa'}
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <StageBadge stage={c.lifecycleStage} />
            <TagChips tags={c.tags} />
          </div>
        </div>
        <div className="flex gap-2">
          {can('contact:write') ? (
            <Button variant="secondary" onClick={() => setEditing(true)}>
              Editar
            </Button>
          ) : null}
          {can('contact:delete') ? (
            <Button
              variant="ghost"
              aria-label="Eliminar contacto"
              onClick={() => setConfirmingDelete(true)}
            >
              <Trash2 aria-hidden />
            </Button>
          ) : null}
        </div>
      </header>

      <section className="grid gap-4 rounded-lg border border-border bg-surface p-5 sm:grid-cols-2">
        <Data label="Correo" icon={<Mail className="size-4" aria-hidden />}>
          {c.email ? (
            <a href={`mailto:${c.email}`} className="text-primary hover:underline">
              {c.email}
            </a>
          ) : null}
        </Data>
        <Data label="Teléfono" icon={<Phone className="size-4" aria-hidden />}>
          {c.phoneE164 ? (
            <a href={`tel:${c.phoneE164}`} className="text-primary hover:underline">
              {c.phoneE164}
            </a>
          ) : null}
        </Data>
        <Data label="WhatsApp" icon={<MessageCircle className="size-4" aria-hidden />}>
          {c.whatsappE164}
        </Data>
        <Data label="Empresa" icon={<Building2 className="size-4" aria-hidden />}>
          {c.company ? (
            <Link
              href={`/w/${slug}/empresas/${c.company.id}`}
              className="text-primary hover:underline"
            >
              {c.company.name}
            </Link>
          ) : (
            c.companyName
          )}
        </Data>
        <Data label="Ciudad">{[c.city, c.country].filter(Boolean).join(', ')}</Data>
        <Data label="Responsable">{c.owner?.name}</Data>
        <Data label="Origen">{c.source === 'manual' ? 'Creado a mano' : c.source}</Data>
        <Data label="Creado">{dateFormat.format(new Date(c.createdAt))}</Data>
      </section>

      <p className="text-sm text-fg-muted">
        Las notas, tareas y la historia del contacto llegan en el siguiente bloque.
      </p>

      {editing ? (
        <ContactForm
          contact={c}
          onClose={() => setEditing(false)}
          onSaved={() => setEditing(false)}
        />
      ) : null}

      {confirmingDelete ? (
        <Dialog
          open
          onClose={() => setConfirmingDelete(false)}
          title={`¿Eliminar a ${c.fullName}?`}
          description="Desaparecerá de los listados. Su correo y teléfono quedan libres para otro contacto."
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

function Data({
  label,
  icon,
  children,
}: {
  label: string;
  icon?: ReactNode;
  children?: ReactNode;
}) {
  const empty = children === null || children === undefined || children === '';
  return (
    <div className="min-w-0">
      <p className="flex items-center gap-1.5 text-xs font-medium tracking-wide text-fg-faint uppercase">
        {icon}
        {label}
      </p>
      <p className="mt-1 truncate text-sm">
        {empty ? <span className="text-fg-faint">—</span> : children}
      </p>
    </div>
  );
}
