'use client';

import {
  canGrant,
  PERMISSION_GROUPS,
  PERMISSIONS,
  type Permission,
  type PermissionMap,
  type RoleView,
  SCOPABLE_PERMISSIONS,
  SCOPE_LABELS,
  type Scope,
} from '@nexo/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Copy, Lock, Minus, Plus } from 'lucide-react';
import { useState } from 'react';
import { ProblemAlert } from '@/components/auth/problem-alert';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { teamApi } from '@/lib/team/api';
import { useAccess } from '@/lib/team/use-access';

const SCOPE_ORDER: Scope[] = ['OWN', 'TEAM', 'ALL'];

type Editor =
  | { mode: 'create'; from?: RoleView }
  | { mode: 'edit'; role: RoleView }
  | { mode: 'view'; role: RoleView }
  | null;

export function RolesSettings() {
  const queryClient = useQueryClient();
  const { access, can } = useAccess();
  const roles = useQuery({ queryKey: ['team', 'roles'], queryFn: teamApi.roles });
  const [editor, setEditor] = useState<Editor>(null);

  if (roles.isLoading || !access) {
    return <div className="h-64 animate-pulse rounded-lg bg-surface-sunken" aria-busy="true" />;
  }
  if (roles.error || !roles.data) return <ProblemAlert error={roles.error} />;

  const manage = can('role:manage');
  const { customRolesEnabled } = roles.data;

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold">Roles</h2>
          <p className="mt-1 text-sm text-fg-muted">
            Qué puede hacer cada persona. El alcance decide sobre qué registros: los suyos, los de
            su equipo o los de toda la empresa.
          </p>
        </div>
        {manage && customRolesEnabled ? (
          <Button onClick={() => setEditor({ mode: 'create' })}>
            <Plus aria-hidden />
            Nuevo rol
          </Button>
        ) : null}
      </div>

      {manage && !customRolesEnabled ? (
        <Alert tone="info" title="Roles personalizados en los planes Pro y Business">
          Con tu plan puedes usar los cinco roles del sistema.
        </Alert>
      ) : null}

      <ul className="grid gap-3 md:grid-cols-2">
        {roles.data.roles.map((role) => {
          const exceedsMe = !canGrant(access.permissions, role.permissions);
          return (
            <li
              key={role.id}
              className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4"
              data-testid={`rol-${role.name}`}
            >
              <div className="flex items-start gap-2">
                <div className="flex-1">
                  <p className="flex items-center gap-2 font-medium">
                    {role.name}
                    {role.isSystem ? (
                      <Badge>
                        <Lock className="size-3" aria-hidden />
                        Sistema
                      </Badge>
                    ) : null}
                  </p>
                  {role.description ? (
                    <p className="mt-1 text-sm text-fg-muted">{role.description}</p>
                  ) : null}
                </div>
                <Badge tone="primary">
                  {role.memberCount} {role.memberCount === 1 ? 'miembro' : 'miembros'}
                </Badge>
              </div>
              <p className="text-xs text-fg-muted">
                {Object.keys(role.permissions).length} de {Object.keys(PERMISSIONS).length} permisos
              </p>
              <div className="mt-auto flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => setEditor({ mode: 'view', role })}
                >
                  Ver permisos
                </Button>
                {manage && customRolesEnabled && role.key !== 'OWNER' ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setEditor({ mode: 'create', from: role })}
                  >
                    <Copy aria-hidden />
                    Duplicar
                  </Button>
                ) : null}
                {manage && !role.isSystem && !exceedsMe ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setEditor({ mode: 'edit', role })}
                  >
                    Editar
                  </Button>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>

      {editor ? (
        <RoleEditor
          key={editor.mode === 'create' ? `create-${editor.from?.id ?? ''}` : editor.role.id}
          editor={editor}
          myPermissions={access.permissions}
          onClose={() => setEditor(null)}
          onDone={() => {
            setEditor(null);
            void queryClient.invalidateQueries({ queryKey: ['team'] });
            void queryClient.invalidateQueries({ queryKey: ['access'] });
          }}
        />
      ) : null}
    </div>
  );
}

/* ========================================================================== */

function RoleEditor({
  editor,
  myPermissions,
  onClose,
  onDone,
}: {
  editor: NonNullable<Editor>;
  myPermissions: PermissionMap;
  onClose: () => void;
  onDone: () => void;
}) {
  const source = editor.mode === 'create' ? editor.from : editor.role;
  const readOnly = editor.mode === 'view';

  // Al duplicar, sólo se copia lo que uno mismo puede conceder.
  const initial: PermissionMap = {};
  for (const [permission, scope] of Object.entries(source?.permissions ?? {}) as Array<
    [Permission, Scope]
  >) {
    if (readOnly || canGrant(myPermissions, { [permission]: scope })) initial[permission] = scope;
  }

  const [name, setName] = useState(
    editor.mode === 'create' ? (source ? `${source.name} (copia)` : '') : (source?.name ?? ''),
  );
  const [description, setDescription] = useState(source?.description ?? '');
  const [permissions, setPermissions] = useState<PermissionMap>(initial);
  const dropped =
    editor.mode === 'create' && source
      ? Object.keys(source.permissions).length - Object.keys(initial).length
      : 0;

  const save = useMutation({
    mutationFn: () => {
      const input = { name, description, permissions };
      return editor.mode === 'edit'
        ? teamApi.updateRole(editor.role.id, input)
        : teamApi.createRole(input);
    },
    onSuccess: onDone,
  });
  const remove = useMutation({
    mutationFn: () => teamApi.deleteRole(source!.id),
    onSuccess: onDone,
  });

  const toggle = (permission: Permission, on: boolean) =>
    setPermissions((current) => {
      const next = { ...current };
      if (on) {
        // El mayor alcance que uno puede conceder.
        next[permission] = SCOPABLE_PERMISSIONS.has(permission)
          ? (myPermissions[permission] ?? 'OWN')
          : 'ALL';
      } else {
        delete next[permission];
      }
      return next;
    });

  const title =
    editor.mode === 'view'
      ? editor.role.name
      : editor.mode === 'edit'
        ? `Editar «${editor.role.name}»`
        : 'Nuevo rol';

  return (
    <Dialog open onClose={onClose} title={title} className="max-w-2xl">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!readOnly) save.mutate();
        }}
        className="grid gap-5"
        noValidate
      >
        <ProblemAlert error={save.error ?? remove.error} />
        {dropped > 0 ? (
          <Alert tone="info" title={`${dropped} permiso(s) no se han copiado`}>
            Son permisos que tu rol no tiene, así que no puedes concederlos.
          </Alert>
        ) : null}

        {!readOnly ? (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Nombre">
              {(a) => <Input {...a} value={name} onChange={(e) => setName(e.target.value)} />}
            </Field>
            <Field label="Descripción (opcional)">
              {(a) => (
                <Input
                  {...a}
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                />
              )}
            </Field>
          </div>
        ) : null}

        <div className="grid max-h-[55vh] gap-5 overflow-y-auto pr-1">
          {PERMISSION_GROUPS.map((group) => (
            <fieldset key={group.label} className="grid gap-1">
              <legend className="mb-1 text-xs font-semibold tracking-wide text-fg-faint uppercase">
                {group.label}
              </legend>
              {group.permissions.map((permission) => {
                const granted = permissions[permission];
                const mine = myPermissions[permission];
                const allowedScopes = SCOPE_ORDER.filter(
                  (s) => mine && SCOPE_ORDER.indexOf(s) <= SCOPE_ORDER.indexOf(mine),
                );
                const locked = readOnly || !mine;
                return (
                  <div
                    key={permission}
                    className="flex min-h-9 items-center gap-3 rounded-md px-2 hover:bg-surface-sunken"
                  >
                    {readOnly ? (
                      <span className="flex flex-1 items-center gap-2 text-sm">
                        {granted ? (
                          <Check className="size-4 text-positive" aria-label="Incluido" />
                        ) : (
                          <Minus className="size-4 text-fg-faint" aria-label="No incluido" />
                        )}
                        <span className={granted ? undefined : 'text-fg-faint'}>
                          {PERMISSIONS[permission]}
                        </span>
                      </span>
                    ) : (
                      <label className="flex flex-1 items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          className="size-4 accent-primary"
                          checked={Boolean(granted)}
                          disabled={locked}
                          onChange={(e) => toggle(permission, e.target.checked)}
                        />
                        <span className={locked && !granted ? 'text-fg-faint' : undefined}>
                          {PERMISSIONS[permission]}
                        </span>
                      </label>
                    )}
                    {granted && SCOPABLE_PERMISSIONS.has(permission) ? (
                      readOnly ? (
                        <span className="text-xs text-fg-muted">{SCOPE_LABELS[granted]}</span>
                      ) : (
                        <select
                          aria-label={`Alcance de «${PERMISSIONS[permission]}»`}
                          value={granted}
                          onChange={(e) =>
                            setPermissions((c) => ({ ...c, [permission]: e.target.value as Scope }))
                          }
                          className="h-7 rounded-md border border-border bg-surface px-1.5 text-xs"
                        >
                          {allowedScopes.map((s) => (
                            <option key={s} value={s}>
                              {SCOPE_LABELS[s]}
                            </option>
                          ))}
                        </select>
                      )
                    ) : null}
                  </div>
                );
              })}
            </fieldset>
          ))}
        </div>

        {!readOnly ? (
          <div className="flex flex-wrap items-center justify-between gap-2">
            {editor.mode === 'edit' ? (
              <Button
                type="button"
                variant="ghost"
                className="text-critical"
                disabled={remove.isPending}
                onClick={() => remove.mutate()}
              >
                Eliminar rol
              </Button>
            ) : (
              <span />
            )}
            <div className="flex gap-2">
              <Button type="button" variant="ghost" onClick={onClose}>
                Cancelar
              </Button>
              <Button
                type="submit"
                disabled={
                  save.isPending || name.trim().length < 2 || Object.keys(permissions).length === 0
                }
              >
                {save.isPending ? 'Guardando…' : 'Guardar rol'}
              </Button>
            </div>
          </div>
        ) : null}
      </form>
    </Dialog>
  );
}
