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
  type ActivityView,
  listTasksSchema,
  noteCreateSchema,
  type NoteView,
  noteUpdateSchema,
  type Paginated,
  taskCreateSchema,
  taskUpdateSchema,
  type TaskView,
} from '@nexo/contracts';
import type { Request } from 'express';
import type { z } from 'zod';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { CurrentAccess, RequirePermission } from '../team/access.decorators';
import type { ResolvedAccess } from '../team/access.service';
import { NotesService } from './notes.service';
import { TasksService } from './tasks.service';

const uuid = new ParseUUIDPipe();

/** Agenda del CRM: tareas, notas e historia de un contacto. */
@ApiTags('Agenda')
@ApiBearerAuth()
@Controller()
export class AgendaController {
  constructor(
    private readonly tasks: TasksService,
    private readonly notes: NotesService,
  ) {}

  /* --- Tareas ---------------------------------------------------------------- */

  @Get('tasks')
  @RequirePermission('task:read')
  @ApiOperation({ summary: 'Tareas por tramo (atrasadas, hoy, próximas, sin fecha, hechas)' })
  listTasks(
    @CurrentAccess() access: ResolvedAccess,
    @Query(new ZodValidationPipe(listTasksSchema)) query: z.infer<typeof listTasksSchema>,
  ): Promise<Paginated<TaskView>> {
    return this.tasks.list(access, query);
  }

  @Post('tasks')
  @RequirePermission('task:write')
  @ApiOperation({ summary: 'Crear una tarea' })
  createTask(
    @CurrentAccess() access: ResolvedAccess,
    @Body(new ZodValidationPipe(taskCreateSchema)) body: z.infer<typeof taskCreateSchema>,
    @Req() req: Request,
  ): Promise<TaskView> {
    return this.tasks.create(access, body, req);
  }

  @Patch('tasks/:id')
  @RequirePermission('task:write')
  @ApiOperation({ summary: 'Editar, completar o reabrir una tarea' })
  updateTask(
    @CurrentAccess() access: ResolvedAccess,
    @Param('id', uuid) id: string,
    @Body(new ZodValidationPipe(taskUpdateSchema)) body: z.infer<typeof taskUpdateSchema>,
    @Req() req: Request,
  ): Promise<TaskView> {
    return this.tasks.update(access, id, body, req);
  }

  @Delete('tasks/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('task:write')
  @ApiOperation({ summary: 'Eliminar una tarea' })
  removeTask(
    @CurrentAccess() access: ResolvedAccess,
    @Param('id', uuid) id: string,
    @Req() req: Request,
  ): Promise<void> {
    return this.tasks.remove(access, id, req);
  }

  /* --- Notas e historia ------------------------------------------------------ */

  @Get('contacts/:id/notes')
  @RequirePermission('contact:read')
  @ApiOperation({ summary: 'Notas de un contacto' })
  listNotes(
    @CurrentAccess() access: ResolvedAccess,
    @Param('id', uuid) id: string,
  ): Promise<NoteView[]> {
    return this.notes.list(access, id);
  }

  @Post('contacts/:id/notes')
  @RequirePermission('contact:write')
  @ApiOperation({ summary: 'Añadir una nota a un contacto' })
  createNote(
    @CurrentAccess() access: ResolvedAccess,
    @Param('id', uuid) id: string,
    @Body(new ZodValidationPipe(noteUpdateSchema)) body: z.infer<typeof noteUpdateSchema>,
    @Req() req: Request,
  ): Promise<NoteView> {
    return this.notes.create(access, noteCreateSchema.parse({ ...body, contactId: id }), req);
  }

  @Patch('notes/:id')
  @RequirePermission('contact:write')
  @ApiOperation({ summary: 'Editar una nota propia' })
  updateNote(
    @CurrentAccess() access: ResolvedAccess,
    @Param('id', uuid) id: string,
    @Body(new ZodValidationPipe(noteUpdateSchema)) body: z.infer<typeof noteUpdateSchema>,
    @Req() req: Request,
  ): Promise<NoteView> {
    return this.notes.update(access, id, body, req);
  }

  @Delete('notes/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('contact:write')
  @ApiOperation({ summary: 'Eliminar una nota propia' })
  removeNote(
    @CurrentAccess() access: ResolvedAccess,
    @Param('id', uuid) id: string,
    @Req() req: Request,
  ): Promise<void> {
    return this.notes.remove(access, id, req);
  }

  @Get('contacts/:id/historia')
  @RequirePermission('contact:read')
  @ApiOperation({ summary: 'Historia del contacto: lo que ha pasado, de lo más reciente' })
  timeline(
    @CurrentAccess() access: ResolvedAccess,
    @Param('id', uuid) id: string,
  ): Promise<ActivityView[]> {
    return this.notes.timeline(access, id);
  }
}
