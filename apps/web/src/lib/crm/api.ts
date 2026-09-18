import type {
  ActivityView,
  BoardQuery,
  BoardView,
  DealCreateInput,
  DealDetail,
  DealLoseInput,
  DealMoveInput,
  DealUpdateInput,
  LostReasonView,
  CompanyCreateInput,
  CompanyDetail,
  CompanyListItem,
  CompanyUpdateInput,
  ContactCreateInput,
  ContactDetail,
  ContactListItem,
  ContactUpdateInput,
  CrmUsage,
  ListCompaniesQuery,
  ListContactsQuery,
  ListTasksQuery,
  NoteView,
  Paginated,
  TagCreateInput,
  TagView,
  TaskCreateInput,
  TaskUpdateInput,
  TaskView,
} from '@nexo/contracts';
import { apiFetch } from '@/lib/api/client';

/** Convierte los filtros en cadena de consulta, omitiendo lo vacío. */
function query(params: Record<string, string | number | boolean | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '' && value !== false) search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : '';
}

export const crmApi = {
  contacts: (params: Partial<ListContactsQuery> = {}) =>
    apiFetch<Paginated<ContactListItem>>(`/contacts${query(params)}`, { auth: true }),

  contact: (id: string) => apiFetch<ContactDetail>(`/contacts/${id}`, { auth: true }),

  createContact: (input: ContactCreateInput) =>
    apiFetch<ContactDetail>('/contacts', { method: 'POST', body: input, auth: true }),

  updateContact: (id: string, input: ContactUpdateInput) =>
    apiFetch<ContactDetail>(`/contacts/${id}`, { method: 'PATCH', body: input, auth: true }),

  deleteContact: (id: string) =>
    apiFetch<void>(`/contacts/${id}`, { method: 'DELETE', auth: true }),

  contactUsage: () => apiFetch<CrmUsage>('/contacts/uso', { auth: true }),

  companies: (params: Partial<ListCompaniesQuery> = {}) =>
    apiFetch<Paginated<CompanyListItem>>(`/companies${query(params)}`, { auth: true }),

  company: (id: string) => apiFetch<CompanyDetail>(`/companies/${id}`, { auth: true }),

  createCompany: (input: CompanyCreateInput) =>
    apiFetch<CompanyDetail>('/companies', { method: 'POST', body: input, auth: true }),

  updateCompany: (id: string, input: CompanyUpdateInput) =>
    apiFetch<CompanyDetail>(`/companies/${id}`, { method: 'PATCH', body: input, auth: true }),

  deleteCompany: (id: string) =>
    apiFetch<void>(`/companies/${id}`, { method: 'DELETE', auth: true }),

  tags: () => apiFetch<TagView[]>('/tags', { auth: true }),

  /* --- Agenda --------------------------------------------------------------- */

  tasks: (params: Partial<ListTasksQuery> = {}) =>
    apiFetch<Paginated<TaskView>>(
      `/tasks${query({ ...params, tzOffset: new Date().getTimezoneOffset() })}`,
      {
        auth: true,
      },
    ),

  createTask: (input: TaskCreateInput) =>
    apiFetch<TaskView>('/tasks', { method: 'POST', body: input, auth: true }),

  updateTask: (id: string, input: TaskUpdateInput) =>
    apiFetch<TaskView>(`/tasks/${id}`, { method: 'PATCH', body: input, auth: true }),

  deleteTask: (id: string) => apiFetch<void>(`/tasks/${id}`, { method: 'DELETE', auth: true }),

  notes: (contactId: string) =>
    apiFetch<NoteView[]>(`/contacts/${contactId}/notes`, { auth: true }),

  createNote: (contactId: string, body: string) =>
    apiFetch<NoteView>(`/contacts/${contactId}/notes`, {
      method: 'POST',
      body: { body },
      auth: true,
    }),

  updateNote: (id: string, body: string) =>
    apiFetch<NoteView>(`/notes/${id}`, { method: 'PATCH', body: { body }, auth: true }),

  deleteNote: (id: string) => apiFetch<void>(`/notes/${id}`, { method: 'DELETE', auth: true }),

  /* --- Embudo --------------------------------------------------------------- */

  board: (params: Partial<BoardQuery> = {}) =>
    apiFetch<BoardView>(`/board${query(params)}`, { auth: true }),

  deal: (id: string) => apiFetch<DealDetail>(`/deals/${id}`, { auth: true }),

  createDeal: (input: DealCreateInput) =>
    apiFetch<DealDetail>('/deals', { method: 'POST', body: input, auth: true }),

  updateDeal: (id: string, input: DealUpdateInput) =>
    apiFetch<DealDetail>(`/deals/${id}`, { method: 'PATCH', body: input, auth: true }),

  moveDeal: (id: string, input: DealMoveInput) =>
    apiFetch<DealDetail>(`/deals/${id}/move`, { method: 'POST', body: input, auth: true }),

  winDeal: (id: string, value?: number) =>
    apiFetch<DealDetail>(`/deals/${id}/win`, {
      method: 'POST',
      body: value === undefined ? {} : { value },
      auth: true,
    }),

  loseDeal: (id: string, input: DealLoseInput) =>
    apiFetch<DealDetail>(`/deals/${id}/lose`, { method: 'POST', body: input, auth: true }),

  deleteDeal: (id: string) => apiFetch<void>(`/deals/${id}`, { method: 'DELETE', auth: true }),

  lostReasons: () => apiFetch<LostReasonView[]>('/lost-reasons', { auth: true }),

  timeline: (contactId: string) =>
    apiFetch<ActivityView[]>(`/contacts/${contactId}/historia`, { auth: true }),

  createTag: (input: TagCreateInput) =>
    apiFetch<TagView>('/tags', { method: 'POST', body: input, auth: true }),

  deleteTag: (id: string) => apiFetch<void>(`/tags/${id}`, { method: 'DELETE', auth: true }),
};
