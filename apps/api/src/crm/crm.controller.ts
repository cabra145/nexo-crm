import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  companyCreateSchema,
  type CompanyDetail,
  type CompanyListItem,
  companyUpdateSchema,
  contactCreateSchema,
  type ContactDetail,
  type ContactListItem,
  contactUpdateSchema,
  type CrmUsage,
  listCompaniesSchema,
  listContactsSchema,
  type Paginated,
  tagCreateSchema,
  type TagView,
} from '@nexo/contracts';
import { runInTenantTransaction } from '@nexo/database';
import type { Request } from 'express';
import type { z } from 'zod';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { CurrentAccess, RequirePermission } from '../team/access.decorators';
import type { ResolvedAccess } from '../team/access.service';
import { loadPlanLimits } from '../team/plan-limits';
import { CompaniesService } from './companies.service';
import { ContactsService } from './contacts.service';
import { TagsService } from './tags.service';

const uuid = new ParseUUIDPipe();

/**
 * CRM: contactos, empresas y etiquetas.
 *
 * Cada ruta declara el permiso que exige; el ALCANCE (qué filas) lo resuelve
 * cada servicio con el rol de la sesión.
 */
@ApiTags('CRM')
@ApiBearerAuth()
@Controller()
export class CrmController {
  constructor(
    private readonly contacts: ContactsService,
    private readonly companies: CompaniesService,
    private readonly tags: TagsService,
  ) {}

  /* --- Contactos ------------------------------------------------------------ */

  @Get('contacts')
  @RequirePermission('contact:read')
  @ApiOperation({ summary: 'Listar y buscar contactos' })
  listContacts(
    @CurrentAccess() access: ResolvedAccess,
    @Query(new ZodValidationPipe(listContactsSchema)) query: z.infer<typeof listContactsSchema>,
  ): Promise<Paginated<ContactListItem>> {
    return this.contacts.list(access, query);
  }

  /** Antes de `contacts/:id`: si no, «uso» se interpretaría como un id. */
  @Get('contacts/uso')
  @RequirePermission('contact:read')
  @ApiOperation({ summary: 'Contactos usados y límite del plan' })
  async usage(): Promise<CrmUsage> {
    const { used, limit } = await runInTenantTransaction(async (tx) => ({
      used: await tx.contact.count({ where: { deletedAt: null } }),
      limit: (await loadPlanLimits(tx)).maxContacts,
    }));
    return { contacts: { used, limit } };
  }

  @Get('contacts/:id')
  @RequirePermission('contact:read')
  @ApiOperation({ summary: 'Ficha de un contacto' })
  getContact(
    @CurrentAccess() access: ResolvedAccess,
    @Param('id', uuid) id: string,
  ): Promise<ContactDetail> {
    return this.contacts.get(access, id);
  }

  @Post('contacts')
  @RequirePermission('contact:write')
  @ApiOperation({ summary: 'Crear un contacto' })
  createContact(
    @CurrentAccess() access: ResolvedAccess,
    @Body(new ZodValidationPipe(contactCreateSchema)) body: z.infer<typeof contactCreateSchema>,
    @Req() req: Request,
  ): Promise<ContactDetail> {
    return this.contacts.create(access, body, req);
  }

  @Patch('contacts/:id')
  @RequirePermission('contact:write')
  @ApiOperation({ summary: 'Editar un contacto' })
  updateContact(
    @CurrentAccess() access: ResolvedAccess,
    @Param('id', uuid) id: string,
    @Body(new ZodValidationPipe(contactUpdateSchema)) body: z.infer<typeof contactUpdateSchema>,
    @Req() req: Request,
  ): Promise<ContactDetail> {
    return this.contacts.update(access, id, body, req);
  }

  @Delete('contacts/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('contact:delete')
  @ApiOperation({ summary: 'Eliminar un contacto' })
  removeContact(
    @CurrentAccess() access: ResolvedAccess,
    @Param('id', uuid) id: string,
    @Req() req: Request,
  ): Promise<void> {
    return this.contacts.remove(access, id, req);
  }

  /* --- Empresas -------------------------------------------------------------- */

  @Get('companies')
  @RequirePermission('company:read')
  @ApiOperation({ summary: 'Listar y buscar empresas' })
  listCompanies(
    @Query(new ZodValidationPipe(listCompaniesSchema)) query: z.infer<typeof listCompaniesSchema>,
  ): Promise<Paginated<CompanyListItem>> {
    return this.companies.list(query);
  }

  @Get('companies/:id')
  @RequirePermission('company:read')
  @ApiOperation({ summary: 'Ficha de una empresa' })
  getCompany(@Param('id', uuid) id: string): Promise<CompanyDetail> {
    return this.companies.get(id);
  }

  @Post('companies')
  @RequirePermission('company:write')
  @ApiOperation({ summary: 'Crear una empresa' })
  createCompany(
    @CurrentAccess() access: ResolvedAccess,
    @Body(new ZodValidationPipe(companyCreateSchema)) body: z.infer<typeof companyCreateSchema>,
    @Req() req: Request,
  ): Promise<CompanyDetail> {
    return this.companies.create(access, body, req);
  }

  @Patch('companies/:id')
  @RequirePermission('company:write')
  @ApiOperation({ summary: 'Editar una empresa' })
  updateCompany(
    @CurrentAccess() access: ResolvedAccess,
    @Param('id', uuid) id: string,
    @Body(new ZodValidationPipe(companyUpdateSchema)) body: z.infer<typeof companyUpdateSchema>,
    @Req() req: Request,
  ): Promise<CompanyDetail> {
    return this.companies.update(access, id, body, req);
  }

  @Delete('companies/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('company:delete')
  @ApiOperation({ summary: 'Eliminar una empresa y desvincular sus contactos' })
  removeCompany(
    @CurrentAccess() access: ResolvedAccess,
    @Param('id', uuid) id: string,
    @Req() req: Request,
  ): Promise<void> {
    return this.companies.remove(access, id, req);
  }

  /* --- Etiquetas ------------------------------------------------------------- */

  @Get('tags')
  @RequirePermission('contact:read')
  @ApiOperation({ summary: 'Etiquetas de la empresa' })
  listTags(): Promise<TagView[]> {
    return this.tags.list();
  }

  @Post('tags')
  @RequirePermission('contact:write')
  @ApiOperation({ summary: 'Crear una etiqueta' })
  createTag(
    @CurrentAccess() access: ResolvedAccess,
    @Body(new ZodValidationPipe(tagCreateSchema)) body: z.infer<typeof tagCreateSchema>,
    @Req() req: Request,
  ): Promise<TagView> {
    return this.tags.create(access, body, req);
  }

  @Delete('tags/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('field:manage')
  @ApiOperation({ summary: 'Eliminar una etiqueta de toda la empresa' })
  removeTag(
    @CurrentAccess() access: ResolvedAccess,
    @Param('id', uuid) id: string,
    @Req() req: Request,
  ): Promise<void> {
    return this.tags.remove(access, id, req);
  }
}
