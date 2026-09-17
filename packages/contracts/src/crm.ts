import { z } from 'zod';
import {
  countrySchema,
  cursorPaginationSchema,
  emailSchema,
  phoneE164Schema,
  searchSchema,
  uuidSchema,
} from './common';

/**
 * Contrato del CRM: contactos, empresas y etiquetas.
 *
 * Los mismos esquemas validan el formulario del navegador y la petición de la
 * API, así que una regla (teléfono en E.164, longitud de un nombre) no puede
 * divergir entre los dos lados.
 */

/* ========================================================================== */
/*  Etapas del ciclo de vida                                                   */
/* ========================================================================== */

export const LIFECYCLE_STAGES = [
  'LEAD',
  'PROSPECT',
  'CUSTOMER',
  'EVANGELIST',
  'CHURNED',
  'OTHER',
] as const;
export type LifecycleStage = (typeof LIFECYCLE_STAGES)[number];

export const LIFECYCLE_LABELS: Record<LifecycleStage, string> = {
  LEAD: 'Contacto inicial',
  PROSPECT: 'Interesado',
  CUSTOMER: 'Cliente',
  EVANGELIST: 'Promotor',
  CHURNED: 'Perdido',
  OTHER: 'Otro',
};

/* ========================================================================== */
/*  Contactos                                                                  */
/* ========================================================================== */

const nombre = (max: number) => z.string().trim().max(max);
/** Texto opcional: '' se guarda como null, no como cadena vacía. */
const opcional = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v === '' ? null : v))
    .nullable()
    .optional();

export const contactCreateSchema = z.object({
  firstName: nombre(80).min(1, 'escribe el nombre'),
  lastName: opcional(80),
  jobTitle: opcional(120),
  /** Empresa del CRM, si existe como registro. */
  companyId: uuidSchema.nullable().optional(),
  /** Nombre libre, para contactos sin empresa creada. */
  companyName: opcional(200),
  email: emailSchema.nullable().optional(),
  phoneE164: phoneE164Schema.nullable().optional(),
  whatsappE164: phoneE164Schema.nullable().optional(),
  addressLine: opcional(200),
  city: opcional(120),
  state: opcional(120),
  postalCode: opcional(20),
  country: countrySchema.nullable().optional(),
  lifecycleStage: z.enum(LIFECYCLE_STAGES).default('LEAD'),
  /** Responsable. Si no llega, el propio creador. */
  ownerId: uuidSchema.nullable().optional(),
  tagIds: z.array(uuidSchema).max(20).optional(),
});
export type ContactCreateInput = z.infer<typeof contactCreateSchema>;

/** Actualización parcial: sólo lo que se manda cambia. */
export const contactUpdateSchema = contactCreateSchema
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'no hay nada que cambiar');
export type ContactUpdateInput = z.infer<typeof contactUpdateSchema>;

export const listContactsSchema = cursorPaginationSchema.merge(searchSchema).extend({
  stage: z.enum(LIFECYCLE_STAGES).optional(),
  ownerId: uuidSchema.optional(),
  companyId: uuidSchema.optional(),
  tagId: uuidSchema.optional(),
  /** Sólo los míos, sea cual sea el alcance del rol. */
  mine: z.coerce.boolean().optional(),
  /** Sin responsable asignado. */
  unassigned: z.coerce.boolean().optional(),
});
export type ListContactsQuery = z.infer<typeof listContactsSchema>;

export interface PersonRef {
  id: string;
  name: string;
}

export interface TagView {
  id: string;
  name: string;
  color: string;
  /** Contactos con la etiqueta. Sólo en el listado de etiquetas. */
  contactCount?: number;
}

export interface ContactListItem {
  id: string;
  fullName: string;
  jobTitle: string | null;
  email: string | null;
  phoneE164: string | null;
  company: { id: string; name: string } | null;
  companyName: string | null;
  lifecycleStage: LifecycleStage;
  owner: PersonRef | null;
  tags: TagView[];
  createdAt: string;
  updatedAt: string;
}

export interface ContactDetail extends ContactListItem {
  firstName: string;
  lastName: string | null;
  whatsappE164: string | null;
  addressLine: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  country: string | null;
  source: string | null;
}

/* ========================================================================== */
/*  Empresas                                                                   */
/* ========================================================================== */

export const companyCreateSchema = z.object({
  name: nombre(200).min(2, 'escribe el nombre de la empresa'),
  legalName: opcional(200),
  taxId: opcional(40),
  industry: opcional(80),
  size: opcional(40),
  website: z
    .string()
    .trim()
    .max(200)
    .transform((v) => (v === '' ? null : v))
    .nullable()
    .optional()
    .refine(
      (v) => v === null || v === undefined || /^(https?:\/\/)?[\w-]+(\.[\w-]+)+([/?#].*)?$/.test(v),
      'escribe una dirección web válida',
    ),
  phone: phoneE164Schema.nullable().optional(),
  email: emailSchema.nullable().optional(),
  addressLine: opcional(200),
  city: opcional(120),
  state: opcional(120),
  postalCode: opcional(20),
  country: countrySchema.nullable().optional(),
});
export type CompanyCreateInput = z.infer<typeof companyCreateSchema>;

export const companyUpdateSchema = companyCreateSchema
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'no hay nada que cambiar');
export type CompanyUpdateInput = z.infer<typeof companyUpdateSchema>;

export const listCompaniesSchema = cursorPaginationSchema.merge(searchSchema);
export type ListCompaniesQuery = z.infer<typeof listCompaniesSchema>;

export interface CompanyListItem {
  id: string;
  name: string;
  industry: string | null;
  city: string | null;
  country: string | null;
  contactCount: number;
  createdAt: string;
}

export interface CompanyDetail extends CompanyListItem {
  legalName: string | null;
  taxId: string | null;
  size: string | null;
  website: string | null;
  phone: string | null;
  email: string | null;
  addressLine: string | null;
  state: string | null;
  postalCode: string | null;
  updatedAt: string;
}

/* ========================================================================== */
/*  Etiquetas                                                                  */
/* ========================================================================== */

export const tagCreateSchema = z.object({
  name: nombre(60).min(1, 'escribe un nombre'),
  color: z
    .string()
    .trim()
    .regex(/^#[0-9a-fA-F]{6}$/, 'color en formato #RRGGBB')
    .optional(),
});
export type TagCreateInput = z.infer<typeof tagCreateSchema>;

/** Paleta de las etiquetas nuevas, en el orden en que se ofrece. */
export const TAG_COLORS = [
  '#0C6B60',
  '#3B82F6',
  '#8B5CF6',
  '#EC4899',
  '#F59E0B',
  '#10B981',
  '#6B7280',
] as const;

/* ========================================================================== */
/*  Límites y errores                                                          */
/* ========================================================================== */

/** Cuántos contactos incluye el plan, y cuántos se usan. */
export interface CrmUsage {
  contacts: { used: number; limit: number | null };
}

export const CRM_PROBLEMS = {
  DUPLICATE_CONTACT: 'https://nexo.app/problems/contacto-duplicado',
  CONTACT_QUOTA: 'https://nexo.app/problems/limite-de-contactos',
} as const;
