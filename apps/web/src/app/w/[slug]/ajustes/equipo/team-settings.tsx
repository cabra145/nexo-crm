'use client';

import { canGrant, inviteMemberSchema, type MemberView, type RoleView } from '@nexo/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Crown, MailPlus, MoreHorizontal, ShieldCheck, UserPlus } from 'lucide-react';
import { type FormEvent, useEffect, useRef, useState } from 'react';
import { CodeInput } from '@/components/auth/code-input';
import { PasswordInput } from '@/components/auth/password-field';
import { ProblemAlert } from '@/components/auth/problem-alert';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { refreshSession } from '@/lib/auth/session';
import { teamApi } from '@/lib/team/api';
import { useAccess } from '@/lib/team/use-access';

const dateFormat = new Intl.DateTimeFormat('es', { day: 'numeric', month: 'short' });

type Dialogs =
  | { kind: 'invite' }
  | { kind: 'edit'; member: MemberView }
  | { kind: 'remove'; member: MemberView }
  | { kind: 'transfer'; member: MemberView }
  | null;

export function TeamSettings() {
  const queryClient = useQueryClient();
  const { access, can } = useAccess();
  const team = useQuery({ queryKey: ['team', 'members'], queryFn: teamApi.members });
  const roles = useQuery({ queryKey: ['team', 'roles'], queryFn: teamApi.roles });
  const [dialog, setDialog] = useState<Dialogs>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<unknown>(null);

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['team'] });

  const action = useMutation({
    mutationFn: async (fn: () => Promise<unknown>) => fn(),
    onMutate: () => {
      setActionError(null);
      setNotice(null);
    },
    onSuccess: () => refresh(),
    onError: setActionError,
  });

  if (team.isLoading || roles.isLoading || !access) {
    return <div className="h-64 animate-pulse rounded-lg bg-surface-sunken" aria-busy="true" />;
  }
  if (team.error || roles.error || !team.data || !roles.data) {
    return <ProblemAlert error={team.error ?? roles.error} />;
  }

  const myPermissions = access.permissions;
  const isOwner = access.role.key === 'OWNER';
  const assignable = roles.data.roles.filter(
    (r) => r.key !== 'OWNER' && canGrant(myPermissions, r.permissions),
  );
  const rolePermissions = new Map(roles.data.roles.map((r) => [r.id, r.permissions]));

  /** Mismas reglas que la API: no a uno mismo, no al propietario, no a quien te supera. */
  const canActOn = (member: MemberView) =>
    member.membershipId !== access.membershipId &&
    member.role.key !== 'OWNER' &&
    canGrant(myPermissions, rolePermissions.get(member.role.id) ?? {});

  const members = team.data.members.filter((m) => m.status !== 'INVITED');
  const invitations = team.data.members.filter((m) => m.status === 'INVITED');
  const { used, limit } = team.data.seats;
  const full = limit !== null && used >= limit;

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold">Equipo</h2>
          <p className="mt-1 text-sm text-fg-muted" data-testid="plazas">
            {limit === null
              ? `${used} usuarios · sin límite en tu plan`
              : `${used} de ${limit} usuarios de tu plan, contando invitaciones pendientes`}
          </p>
        </div>
        {can('member:invite') ? (
          <Button onClick={() => setDialog({ kind: 'invite' })} disabled={full}>
            <UserPlus aria-hidden />
            Invitar
          </Button>
        ) : null}
      </div>

      {full && can('member:invite') ? (
        <Alert tone="warning" title="Has ocupado todas las plazas de tu plan">
          Para invitar a alguien más, desactiva a un miembro, cancela una invitación o mejora el
          plan.
        </Alert>
      ) : null}
      {notice ? <Alert tone="positive" title={notice} /> : null}
      <ProblemAlert error={actionError} />

      {/* --- Miembros ------------------------------------------------------ */}
      <section aria-labelledby="miembros">
        <h3 id="miembros" className="sr-only">
          Miembros
        </h3>
        <ul className="divide-y divide-border rounded-lg border border-border bg-surface">
          {members.map((member) => (
            <li
              key={member.membershipId}
              className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3"
              data-testid={`miembro-${member.email}`}
            >
              <Avatar name={member.name} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">
                  {member.name}
                  {member.membershipId === access.membershipId ? (
                    <span className="font-normal text-fg-muted"> (tú)</span>
                  ) : null}
                </p>
                <p className="truncate text-xs text-fg-muted">{member.email}</p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {member.teamName ? <Badge>{member.teamName}</Badge> : null}
                <Badge tone={member.role.key === 'OWNER' ? 'primary' : 'neutral'}>
                  {member.role.key === 'OWNER' ? <Crown className="size-3" aria-hidden /> : null}
                  {member.role.name}
                </Badge>
                {member.status === 'DISABLED' ? <Badge tone="warning">Desactivado</Badge> : null}
                {member.twoFactorEnabled ? (
                  <ShieldCheck className="size-4 text-positive" aria-label="2FA activado" />
                ) : null}
              </div>
              {(can('member:manage') && canActOn(member)) ||
              (isOwner &&
                member.status === 'ACTIVE' &&
                member.membershipId !== access.membershipId) ? (
                <RowMenu
                  label={`Acciones para ${member.email}`}
                  items={[
                    ...(can('member:manage') && canActOn(member)
                      ? [
                          {
                            label: 'Cambiar rol o equipo',
                            onSelect: () => setDialog({ kind: 'edit', member }),
                          },
                          member.status === 'ACTIVE'
                            ? {
                                label: 'Desactivar',
                                onSelect: () =>
                                  action.mutate(() =>
                                    teamApi.setDisabled(member.membershipId, true),
                                  ),
                              }
                            : {
                                label: 'Reactivar',
                                onSelect: () =>
                                  action.mutate(() =>
                                    teamApi.setDisabled(member.membershipId, false),
                                  ),
                              },
                          {
                            label: 'Dar de baja',
                            danger: true,
                            onSelect: () => setDialog({ kind: 'remove', member }),
                          },
                        ]
                      : []),
                    ...(isOwner &&
                    member.status === 'ACTIVE' &&
                    member.membershipId !== access.membershipId
                      ? [
                          {
                            label: 'Transferir la propiedad',
                            onSelect: () => setDialog({ kind: 'transfer', member }),
                          },
                        ]
                      : []),
                  ]}
                />
              ) : (
                <span className="size-8" aria-hidden />
              )}
            </li>
          ))}
        </ul>
      </section>

      {/* --- Invitaciones pendientes -------------------------------------- */}
      {invitations.length > 0 ? (
        <section aria-labelledby="invitaciones" className="grid grid-cols-[minmax(0,1fr)] gap-3">
          <h3 id="invitaciones" className="text-sm font-semibold">
            Invitaciones pendientes
          </h3>
          <ul className="divide-y divide-border rounded-lg border border-border bg-surface">
            {invitations.map((inv) => (
              <li
                key={inv.membershipId}
                className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3"
                data-testid={`invitacion-${inv.email}`}
              >
                <span className="grid size-8 place-items-center rounded-full bg-surface-sunken">
                  <MailPlus className="size-4 text-fg-muted" aria-hidden />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{inv.email}</p>
                  <p className="text-xs text-fg-muted">
                    {inv.role.name}
                    {inv.invitationExpiresAt
                      ? ` · caduca el ${dateFormat.format(new Date(inv.invitationExpiresAt))}`
                      : ' · enlace caducado'}
                  </p>
                </div>
                {can('member:invite') && canActOn(inv) ? (
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={action.isPending}
                      onClick={() =>
                        action.mutate(async () => {
                          await teamApi.resendInvitation(inv.membershipId);
                          setNotice(`Invitación reenviada a ${inv.email}`);
                        })
                      }
                    >
                      Reenviar
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={action.isPending}
                      onClick={() =>
                        action.mutate(() => teamApi.cancelInvitation(inv.membershipId))
                      }
                    >
                      Cancelar
                    </Button>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {/* --- Diálogos -------------------------------------------------------- */}
      <InviteDialog
        open={dialog?.kind === 'invite'}
        roles={assignable}
        onClose={() => setDialog(null)}
        onDone={(email) => {
          setDialog(null);
          setNotice(`Invitación enviada a ${email}`);
          void refresh();
        }}
      />
      {dialog?.kind === 'edit' ? (
        <EditMemberDialog
          member={dialog.member}
          roles={assignable}
          onClose={() => setDialog(null)}
          onDone={() => {
            setDialog(null);
            void refresh();
          }}
        />
      ) : null}
      {dialog?.kind === 'remove' ? (
        <Dialog
          open
          onClose={() => setDialog(null)}
          title={`¿Dar de baja a ${dialog.member.name}?`}
          description="Pierde el acceso a la empresa al instante. Sus datos (contactos, oportunidades) se quedan en la empresa."
        >
          <ProblemAlert error={action.error} />
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setDialog(null)}>
              Cancelar
            </Button>
            <Button
              variant="destructive"
              disabled={action.isPending}
              onClick={() =>
                action.mutate(() => teamApi.removeMember(dialog.member.membershipId), {
                  onSuccess: () => setDialog(null),
                })
              }
            >
              Dar de baja
            </Button>
          </div>
        </Dialog>
      ) : null}
      {dialog?.kind === 'transfer' ? (
        <TransferDialog
          member={dialog.member}
          onClose={() => setDialog(null)}
          onDone={async () => {
            setDialog(null);
            // El rol cambió: la sesión se renueva para que lo refleje.
            await refreshSession({ force: true });
            await queryClient.invalidateQueries();
            setNotice(`${dialog.member.name} es ahora el propietario. Tú pasas a administrador.`);
          }}
        />
      ) : null}
    </div>
  );
}

/* ========================================================================== */

function Avatar({ name }: { name: string }) {
  const letters = name
    .split(/[\s@.]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase())
    .join('');
  return (
    <span
      aria-hidden
      className="grid size-8 shrink-0 place-items-center rounded-full bg-primary-subtle text-xs font-semibold text-primary"
    >
      {letters}
    </span>
  );
}

function RowMenu({
  label,
  items,
}: {
  label: string;
  items: Array<{ label: string; onSelect: () => void; danger?: boolean }>;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', close);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <Button
        size="icon"
        variant="ghost"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <MoreHorizontal aria-hidden />
      </Button>
      {open ? (
        <div
          role="menu"
          className="absolute right-0 z-10 mt-1 w-56 overflow-hidden rounded-lg border border-border bg-surface-raised p-1 shadow-overlay"
        >
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                item.onSelect();
              }}
              className={
                item.danger
                  ? 'flex w-full rounded-md px-2 py-1.5 text-left text-sm text-critical hover:bg-critical-subtle'
                  : 'flex w-full rounded-md px-2 py-1.5 text-left text-sm text-fg hover:bg-surface-sunken'
              }
            >
              {item.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function InviteDialog({
  open,
  roles,
  onClose,
  onDone,
}: {
  open: boolean;
  roles: RoleView[];
  onClose: () => void;
  onDone: (email: string) => void;
}) {
  const [email, setEmail] = useState('');
  const [roleId, setRoleId] = useState('');
  const [teamName, setTeamName] = useState('');
  const invite = useMutation({ mutationFn: teamApi.invite });

  const defaultRole = roles.find((r) => r.key === 'AGENT') ?? roles[0];
  const effectiveRole = roleId || defaultRole?.id || '';
  const parsed = inviteMemberSchema.safeParse({ email, roleId: effectiveRole, teamName });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!parsed.success) return;
    invite.mutate(parsed.data, {
      onSuccess: () => {
        onDone(parsed.data.email);
        setEmail('');
        setTeamName('');
        setRoleId('');
        invite.reset();
      },
    });
  };

  return (
    <Dialog
      open={open}
      onClose={() => {
        invite.reset();
        onClose();
      }}
      title="Invitar al equipo"
      description="Le enviaremos un enlace por correo. Caduca en 7 días."
    >
      <form onSubmit={submit} className="grid gap-4" noValidate>
        <ProblemAlert error={invite.error} />
        <Field label="Correo">
          {(a) => (
            <Input
              {...a}
              type="email"
              autoComplete="off"
              autoFocus
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          )}
        </Field>
        <Field
          label="Rol"
          hint={roles.find((r) => r.id === effectiveRole)?.description ?? undefined}
        >
          {(a) => (
            <Select {...a} value={effectiveRole} onChange={(e) => setRoleId(e.target.value)}>
              {roles.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Equipo (opcional)" hint="Los responsables ven el trabajo de su equipo.">
          {(a) => <Input {...a} value={teamName} onChange={(e) => setTeamName(e.target.value)} />}
        </Field>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button type="submit" disabled={!parsed.success || invite.isPending}>
            {invite.isPending ? 'Enviando…' : 'Enviar invitación'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function EditMemberDialog({
  member,
  roles,
  onClose,
  onDone,
}: {
  member: MemberView;
  roles: RoleView[];
  onClose: () => void;
  onDone: () => void;
}) {
  const [roleId, setRoleId] = useState(member.role.id);
  const [teamName, setTeamName] = useState(member.teamName ?? '');
  const update = useMutation({
    mutationFn: () =>
      teamApi.updateMember(member.membershipId, {
        ...(roleId !== member.role.id ? { roleId } : {}),
        teamName: teamName.trim() === '' ? null : teamName.trim(),
      }),
    onSuccess: onDone,
  });

  return (
    <Dialog open onClose={onClose} title={`Acceso de ${member.name}`} description={member.email}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          update.mutate();
        }}
        className="grid gap-4"
        noValidate
      >
        <ProblemAlert error={update.error} />
        <Field label="Rol">
          {(a) => (
            <Select {...a} value={roleId} onChange={(e) => setRoleId(e.target.value)}>
              {roles.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Equipo">
          {(a) => <Input {...a} value={teamName} onChange={(e) => setTeamName(e.target.value)} />}
        </Field>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button type="submit" disabled={update.isPending}>
            {update.isPending ? 'Guardando…' : 'Guardar'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function TransferDialog({
  member,
  onClose,
  onDone,
}: {
  member: MemberView;
  onClose: () => void;
  onDone: () => Promise<void>;
}) {
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const transfer = useMutation({
    mutationFn: () =>
      teamApi.transferOwnership({ membershipId: member.membershipId, password, code }),
    onSuccess: onDone,
  });

  return (
    <Dialog
      open
      onClose={onClose}
      title="Transferir la propiedad"
      description={
        <>
          <strong className="text-fg">{member.name}</strong> pasará a ser el propietario, con
          control sobre el plan y la facturación. Tú pasarás a administrador. No se puede deshacer
          sin su permiso.
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          transfer.mutate();
        }}
        className="grid gap-4"
        noValidate
      >
        {!member.twoFactorEnabled ? (
          <Alert tone="warning" title="Necesita la verificación en dos pasos">
            {member.name} tiene que activarla antes de poder ser propietario.
          </Alert>
        ) : null}
        <ProblemAlert error={transfer.error} />
        <Field label="Tu contraseña">
          {(a) => (
            <PasswordInput
              {...a}
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          )}
        </Field>
        <Field label="Código de tu autenticador">
          {(a) => <CodeInput {...a} value={code} onChange={(e) => setCode(e.target.value)} />}
        </Field>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            type="submit"
            variant="destructive"
            disabled={transfer.isPending || !password || code.length !== 6}
          >
            {transfer.isPending ? 'Transfiriendo…' : 'Transferir'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
