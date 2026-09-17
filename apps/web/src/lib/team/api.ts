import type {
  AccessView,
  InvitationAccepted,
  InvitationPreview,
  InviteMemberInput,
  MemberView,
  RoleInput,
  RolesView,
  RoleView,
  SessionResponse,
  TeamView,
  TransferOwnershipInput,
  UpdateMemberInput,
} from '@nexo/contracts';
import { apiFetch } from '@/lib/api/client';

/** Equipo, roles e invitaciones, con los tipos del contrato compartido con la API. */
export const teamApi = {
  access: () => apiFetch<AccessView>('/access', { auth: true }),

  members: () => apiFetch<TeamView>('/team/members', { auth: true }),

  invite: (input: InviteMemberInput) =>
    apiFetch<MemberView>('/team/invitations', { method: 'POST', body: input, auth: true }),

  resendInvitation: (membershipId: string) =>
    apiFetch<MemberView>(`/team/invitations/${membershipId}/resend`, {
      method: 'POST',
      auth: true,
    }),

  cancelInvitation: (membershipId: string) =>
    apiFetch<void>(`/team/invitations/${membershipId}`, { method: 'DELETE', auth: true }),

  updateMember: (membershipId: string, input: UpdateMemberInput) =>
    apiFetch<MemberView>(`/team/members/${membershipId}`, {
      method: 'PATCH',
      body: input,
      auth: true,
    }),

  setDisabled: (membershipId: string, disabled: boolean) =>
    apiFetch<MemberView>(`/team/members/${membershipId}/${disabled ? 'disable' : 'enable'}`, {
      method: 'POST',
      auth: true,
    }),

  removeMember: (membershipId: string) =>
    apiFetch<void>(`/team/members/${membershipId}`, { method: 'DELETE', auth: true }),

  transferOwnership: (input: TransferOwnershipInput) =>
    apiFetch<void>('/team/transfer-ownership', { method: 'POST', body: input, auth: true }),

  roles: () => apiFetch<RolesView>('/team/roles', { auth: true }),

  createRole: (input: RoleInput) =>
    apiFetch<RoleView>('/team/roles', { method: 'POST', body: input, auth: true }),

  updateRole: (roleId: string, input: RoleInput) =>
    apiFetch<RoleView>(`/team/roles/${roleId}`, { method: 'PATCH', body: input, auth: true }),

  deleteRole: (roleId: string) =>
    apiFetch<void>(`/team/roles/${roleId}`, { method: 'DELETE', auth: true }),

  /* --- Invitaciones (pantalla pública) ------------------------------------- */

  previewInvitation: (token: string) =>
    apiFetch<InvitationPreview>('/invitations/preview', { method: 'POST', body: { token } }),

  acceptWithNewAccount: (input: { token: string; name: string; password: string }) =>
    apiFetch<SessionResponse>('/invitations/accept-new', { method: 'POST', body: input }),

  acceptWithSession: (token: string) =>
    apiFetch<InvitationAccepted>('/invitations/accept', {
      method: 'POST',
      body: { token },
      auth: true,
    }),
};
