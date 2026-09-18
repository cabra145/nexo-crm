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
  boardQuerySchema,
  type BoardView,
  dealCreateSchema,
  type DealDetail,
  dealLoseSchema,
  dealMoveSchema,
  dealUpdateSchema,
  dealWinSchema,
  type LostReasonView,
} from '@nexo/contracts';
import type { Request } from 'express';
import type { z } from 'zod';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { CurrentAccess, RequirePermission } from '../team/access.decorators';
import type { ResolvedAccess } from '../team/access.service';
import { DealsService } from './deals.service';

const uuid = new ParseUUIDPipe();

/** Embudo de ventas: tablero y oportunidades. */
@ApiTags('Embudo')
@ApiBearerAuth()
@Controller()
export class DealsController {
  constructor(private readonly deals: DealsService) {}

  @Get('board')
  @RequirePermission('deal:read')
  @ApiOperation({ summary: 'Tablero del embudo, por columnas' })
  board(
    @CurrentAccess() access: ResolvedAccess,
    @Query(new ZodValidationPipe(boardQuerySchema)) query: z.infer<typeof boardQuerySchema>,
  ): Promise<BoardView> {
    return this.deals.board(access, query);
  }

  @Get('lost-reasons')
  @RequirePermission('deal:read')
  @ApiOperation({ summary: 'Motivos de pérdida de la empresa' })
  lostReasons(): Promise<LostReasonView[]> {
    return this.deals.lostReasons();
  }

  @Get('deals/:id')
  @RequirePermission('deal:read')
  @ApiOperation({ summary: 'Ficha de una oportunidad, con su paso por las etapas' })
  get(@CurrentAccess() access: ResolvedAccess, @Param('id', uuid) id: string): Promise<DealDetail> {
    return this.deals.get(access, id);
  }

  @Post('deals')
  @RequirePermission('deal:write')
  @ApiOperation({ summary: 'Crear una oportunidad' })
  create(
    @CurrentAccess() access: ResolvedAccess,
    @Body(new ZodValidationPipe(dealCreateSchema)) body: z.infer<typeof dealCreateSchema>,
    @Req() req: Request,
  ): Promise<DealDetail> {
    return this.deals.create(access, body, req);
  }

  @Patch('deals/:id')
  @RequirePermission('deal:write')
  @ApiOperation({ summary: 'Editar una oportunidad' })
  update(
    @CurrentAccess() access: ResolvedAccess,
    @Param('id', uuid) id: string,
    @Body(new ZodValidationPipe(dealUpdateSchema)) body: z.infer<typeof dealUpdateSchema>,
    @Req() req: Request,
  ): Promise<DealDetail> {
    return this.deals.update(access, id, body, req);
  }

  @Post('deals/:id/move')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('deal:write')
  @ApiOperation({ summary: 'Mover la tarjeta a una etapa y a un hueco entre otras dos' })
  move(
    @CurrentAccess() access: ResolvedAccess,
    @Param('id', uuid) id: string,
    @Body(new ZodValidationPipe(dealMoveSchema)) body: z.infer<typeof dealMoveSchema>,
    @Req() req: Request,
  ): Promise<DealDetail> {
    return this.deals.move(access, id, body, req);
  }

  @Post('deals/:id/win')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('deal:write')
  @ApiOperation({ summary: 'Marcar como ganada' })
  win(
    @CurrentAccess() access: ResolvedAccess,
    @Param('id', uuid) id: string,
    @Body(new ZodValidationPipe(dealWinSchema)) body: z.infer<typeof dealWinSchema>,
    @Req() req: Request,
  ): Promise<DealDetail> {
    return this.deals.win(access, id, body.value, req);
  }

  @Post('deals/:id/lose')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('deal:write')
  @ApiOperation({ summary: 'Marcar como perdida, con su motivo' })
  lose(
    @CurrentAccess() access: ResolvedAccess,
    @Param('id', uuid) id: string,
    @Body(new ZodValidationPipe(dealLoseSchema)) body: z.infer<typeof dealLoseSchema>,
    @Req() req: Request,
  ): Promise<DealDetail> {
    return this.deals.lose(access, id, body, req);
  }

  @Delete('deals/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('deal:delete')
  @ApiOperation({ summary: 'Eliminar una oportunidad' })
  remove(
    @CurrentAccess() access: ResolvedAccess,
    @Param('id', uuid) id: string,
    @Req() req: Request,
  ): Promise<void> {
    return this.deals.remove(access, id, req);
  }
}
