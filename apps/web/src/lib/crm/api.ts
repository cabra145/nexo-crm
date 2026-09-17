import type {
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
  Paginated,
  TagCreateInput,
  TagView,
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

  createTag: (input: TagCreateInput) =>
    apiFetch<TagView>('/tags', { method: 'POST', body: input, auth: true }),

  deleteTag: (id: string) => apiFetch<void>(`/tags/${id}`, { method: 'DELETE', auth: true }),
};
