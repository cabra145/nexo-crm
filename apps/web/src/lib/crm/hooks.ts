'use client';

import type { BoardQuery, ListContactsQuery, ListTasksQuery } from '@nexo/contracts';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { crmApi } from './api';

/** Claves de caché del CRM. Todo lo del CRM cuelga de 'crm' para invalidarlo junto. */
export const crmKeys = {
  contacts: (filters: Partial<ListContactsQuery>) => ['crm', 'contacts', filters] as const,
  contact: (id: string) => ['crm', 'contact', id] as const,
  companies: (q: string) => ['crm', 'companies', q] as const,
  company: (id: string) => ['crm', 'company', id] as const,
  tags: () => ['crm', 'tags'] as const,
  usage: () => ['crm', 'usage'] as const,
};

/**
 * Contactos con «cargar más» por cursor.
 *
 * Con búsqueda la API devuelve una sola página ordenada por relevancia, así
 * que no hay cursor: `getNextPageParam` devuelve undefined y el botón no sale.
 */
export function useContacts(filters: Partial<ListContactsQuery>) {
  return useInfiniteQuery({
    queryKey: crmKeys.contacts(filters),
    queryFn: ({ pageParam }) =>
      crmApi.contacts({ ...filters, ...(pageParam ? { cursor: pageParam } : {}) }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
}

export const useContact = (id: string) =>
  useQuery({ queryKey: crmKeys.contact(id), queryFn: () => crmApi.contact(id) });

export const useTags = () => useQuery({ queryKey: crmKeys.tags(), queryFn: crmApi.tags });

export const useContactUsage = () =>
  useQuery({ queryKey: crmKeys.usage(), queryFn: crmApi.contactUsage });

export const useCompanies = (q: string) =>
  useQuery({
    queryKey: crmKeys.companies(q),
    queryFn: () => crmApi.companies({ q: q || undefined }),
  });

export const useCompany = (id: string) =>
  useQuery({ queryKey: crmKeys.company(id), queryFn: () => crmApi.company(id) });

/** Tareas de un tramo de la agenda. */
export const useTasks = (params: Partial<ListTasksQuery>) =>
  useQuery({
    queryKey: ['crm', 'tasks', params],
    queryFn: () => crmApi.tasks(params),
  });

export const useNotes = (contactId: string) =>
  useQuery({ queryKey: ['crm', 'notes', contactId], queryFn: () => crmApi.notes(contactId) });

export const useTimeline = (contactId: string) =>
  useQuery({ queryKey: ['crm', 'timeline', contactId], queryFn: () => crmApi.timeline(contactId) });

export const boardKey = (params: Partial<BoardQuery>) => ['crm', 'board', params] as const;

export const useBoard = (params: Partial<BoardQuery>) =>
  useQuery({ queryKey: boardKey(params), queryFn: () => crmApi.board(params) });

export const useDeal = (id: string | null) =>
  useQuery({
    queryKey: ['crm', 'deal', id],
    queryFn: () => crmApi.deal(id!),
    enabled: Boolean(id),
  });

export const useLostReasons = () =>
  useQuery({ queryKey: ['crm', 'lost-reasons'], queryFn: crmApi.lostReasons, staleTime: 300_000 });

/** Espera a que el usuario deje de escribir antes de consultar. */
export function useDebounced<T>(value: T, ms = 300): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return debounced;
}
