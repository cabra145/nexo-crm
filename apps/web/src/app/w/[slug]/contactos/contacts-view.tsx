'use client';

import { LIFECYCLE_LABELS, LIFECYCLE_STAGES, type ContactDetail } from '@nexo/contracts';
import { Search, UserPlus, Users } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { ProblemAlert } from '@/components/auth/problem-alert';
import { ContactForm } from '@/components/crm/contact-form';
import { StageBadge } from '@/components/crm/stage-badge';
import { TagChips } from '@/components/crm/tag-chips';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { useContacts, useContactUsage, useDebounced, useTags } from '@/lib/crm/hooks';
import { useAccess } from '@/lib/team/use-access';

/**
 * Listado de contactos: buscar, filtrar y dar de alta.
 *
 * Lo que se ve depende del rol y lo decide la API: un agente recibe sólo sus
 * contactos. Aquí no se filtra por dueño «a mano» salvo que el usuario lo pida.
 */
export function ContactsView({ slug }: { slug: string }) {
  const router = useRouter();
  const { access, can } = useAccess();
  const [search, setSearch] = useState('');
  const [stage, setStage] = useState('');
  const [tagId, setTagId] = useState('');
  const [mine, setMine] = useState(false);
  const [creating, setCreating] = useState(false);

  const q = useDebounced(search.trim());
  const filters = {
    ...(q.length >= 2 ? { q } : {}),
    ...(stage ? { stage: stage as (typeof LIFECYCLE_STAGES)[number] } : {}),
    ...(tagId ? { tagId } : {}),
    ...(mine ? { mine: true } : {}),
  };
  const contacts = useContacts(filters);
  const tags = useTags();
  // El consumo del plan es de toda la empresa: sólo tiene sentido para quien
  // ve todos los contactos. A un agente, «2 de 5000» le diría de más y le
  // explicaría de menos.
  const seesAll = access?.permissions['contact:read'] === 'ALL';
  const usage = useContactUsage();

  const rows = contacts.data?.pages.flatMap((page) => page.data) ?? [];
  const filtering = Boolean(q || stage || tagId || mine);
  const limitReached =
    usage.data?.contacts.limit !== null &&
    usage.data !== undefined &&
    usage.data.contacts.used >= (usage.data.contacts.limit ?? Infinity);

  const openContact = (contact: ContactDetail) => router.push(`/w/${slug}/contactos/${contact.id}`);

  return (
    <div className="mx-auto grid max-w-5xl grid-cols-[minmax(0,1fr)] gap-6 px-4 py-8 sm:px-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Contactos</h1>
          <p className="mt-1 text-sm text-fg-muted" data-testid="uso-contactos">
            {!seesAll
              ? 'Los contactos de los que te ocupas.'
              : usage.data
                ? usage.data.contacts.limit === null
                  ? `${usage.data.contacts.used} contactos`
                  : `${usage.data.contacts.used} de ${usage.data.contacts.limit} contactos de tu plan`
                : ' '}
          </p>
        </div>
        {can('contact:write') ? (
          <Button onClick={() => setCreating(true)} disabled={limitReached}>
            <UserPlus aria-hidden />
            Nuevo contacto
          </Button>
        ) : null}
      </div>

      {limitReached && can('contact:write') ? (
        <Alert tone="warning" title="Has llegado al límite de contactos de tu plan">
          Elimina los que no uses o mejora el plan para seguir añadiendo.
        </Alert>
      ) : null}

      {/* --- Buscador y filtros ---------------------------------------------- */}
      <div className="flex flex-wrap gap-2">
        <div className="relative min-w-52 flex-1">
          <Search
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-fg-faint"
            aria-hidden
          />
          <Input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Nombre, correo, teléfono o empresa"
            aria-label="Buscar contactos"
            className="pl-9"
          />
        </div>
        <Select
          value={stage}
          onChange={(e) => setStage(e.target.value)}
          aria-label="Filtrar por etapa"
          className="w-44"
        >
          <option value="">Todas las etapas</option>
          {LIFECYCLE_STAGES.map((s) => (
            <option key={s} value={s}>
              {LIFECYCLE_LABELS[s]}
            </option>
          ))}
        </Select>
        {(tags.data ?? []).length > 0 ? (
          <Select
            value={tagId}
            onChange={(e) => setTagId(e.target.value)}
            aria-label="Filtrar por etiqueta"
            className="w-44"
          >
            <option value="">Todas las etiquetas</option>
            {(tags.data ?? []).map((tag) => (
              <option key={tag.id} value={tag.id}>
                {tag.name}
              </option>
            ))}
          </Select>
        ) : null}
        <label className="flex h-9 cursor-pointer items-center gap-2 rounded-md border border-border px-3 text-sm">
          <input
            type="checkbox"
            className="size-4 accent-primary"
            checked={mine}
            onChange={(e) => setMine(e.target.checked)}
          />
          Sólo míos
        </label>
      </div>

      {/* --- Resultados ------------------------------------------------------- */}
      {contacts.error ? <ProblemAlert error={contacts.error} /> : null}

      {contacts.isLoading ? (
        <div className="grid gap-2" aria-busy="true">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="h-14 animate-pulse rounded-lg bg-surface-sunken" />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <div className="grid justify-items-center gap-3 rounded-lg border border-dashed border-border px-6 py-16 text-center">
          <Users className="size-8 text-fg-faint" aria-hidden />
          <p className="font-medium">
            {filtering ? 'Ningún contacto coincide' : 'Todavía no hay contactos'}
          </p>
          <p className="max-w-sm text-sm text-fg-muted">
            {filtering
              ? 'Prueba con otras palabras o quita los filtros.'
              : 'Aquí vivirán las personas con las que hablas: sus datos, su historia y sus tareas.'}
          </p>
          {!filtering && can('contact:write') ? (
            <Button className="mt-1" onClick={() => setCreating(true)} disabled={limitReached}>
              <UserPlus aria-hidden />
              Crear el primero
            </Button>
          ) : null}
        </div>
      ) : (
        <>
          <ul className="divide-y divide-border rounded-lg border border-border bg-surface">
            {rows.map((contact) => (
              <li key={contact.id} data-testid={`contacto-${contact.id}`}>
                <Link
                  href={`/w/${slug}/contactos/${contact.id}`}
                  className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 hover:bg-surface-sunken"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{contact.fullName}</p>
                    <p className="truncate text-xs text-fg-muted">
                      {[
                        contact.jobTitle,
                        contact.company?.name ?? contact.companyName,
                        contact.email,
                      ]
                        .filter(Boolean)
                        .join(' · ') || 'Sin más datos'}
                    </p>
                  </div>
                  <TagChips tags={contact.tags} />
                  <StageBadge stage={contact.lifecycleStage} />
                  {/* En móvil el nombre manda: el responsable se oculta. */}
                  <span className="hidden w-28 truncate text-right text-xs text-fg-muted sm:block">
                    {contact.owner?.name ?? 'Sin responsable'}
                  </span>
                </Link>
              </li>
            ))}
          </ul>

          {contacts.hasNextPage ? (
            <Button
              variant="secondary"
              className="justify-self-center"
              disabled={contacts.isFetchingNextPage}
              onClick={() => void contacts.fetchNextPage()}
            >
              {contacts.isFetchingNextPage ? 'Cargando…' : 'Cargar más'}
            </Button>
          ) : null}
        </>
      )}

      {creating ? <ContactForm onClose={() => setCreating(false)} onSaved={openContact} /> : null}
    </div>
  );
}
