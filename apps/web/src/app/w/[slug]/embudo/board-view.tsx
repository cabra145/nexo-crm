'use client';

import type { BoardColumn, BoardView as Board, DealCard } from '@nexo/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Plus } from 'lucide-react';
import { type DragEvent, useState } from 'react';
import { ProblemAlert } from '@/components/auth/problem-alert';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { crmApi } from '@/lib/crm/api';
import { boardKey, useBoard } from '@/lib/crm/hooks';
import { useAccess } from '@/lib/team/use-access';
import { cn } from '@/lib/utils';
import { DealDialog } from './deal-dialog';
import { NewDealDialog } from './new-deal-dialog';

export const money = (value: number, currency: string) =>
  new Intl.NumberFormat('es', { style: 'currency', currency, maximumFractionDigits: 0 }).format(
    value,
  );

interface Move {
  dealId: string;
  stageId: string;
  /** Tarjeta delante de la que se suelta; null = al final de la columna. */
  beforeDealId: string | null;
}

/**
 * Tablero del embudo.
 *
 * Arrastrar una tarjeta la mueve AL INSTANTE en pantalla y después se lo
 * cuenta a la API; si la API lo rechaza, vuelve a su sitio y se explica por
 * qué. Esperar la respuesta para moverla haría que el tablero se sintiera
 * pegajoso justo en lo que más se usa.
 *
 * Arrastrar no es la única forma: cada tarjeta tiene un selector «Mover a…»
 * que funciona con teclado, lector de pantalla y pantallas táctiles.
 */
export function BoardView({ slug }: { slug: string }) {
  const queryClient = useQueryClient();
  const { access, can } = useAccess();
  const [mine, setMine] = useState(false);
  const [pipelineId, setPipelineId] = useState<string | undefined>(undefined);
  const params = { ...(pipelineId ? { pipelineId } : {}), ...(mine ? { mine: true } : {}) };
  const board = useBoard(params);
  const [dragging, setDragging] = useState<string | null>(null);
  const [overStage, setOverStage] = useState<string | null>(null);
  const [openDeal, setOpenDeal] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const canWrite = can('deal:write');
  const seesOthers = access?.permissions['deal:read'] !== 'OWN';

  const move = useMutation({
    mutationFn: ({ dealId, stageId, beforeDealId }: Move) => {
      const column = board.data?.columns.find((c) => c.stage.id === stageId);
      const others = (column?.deals ?? []).filter((d) => d.id !== dealId);
      const index = beforeDealId ? others.findIndex((d) => d.id === beforeDealId) : others.length;
      return crmApi.moveDeal(dealId, {
        stageId,
        afterDealId: index > 0 ? others[index - 1]!.id : null,
        beforeDealId: beforeDealId ?? null,
      });
    },
    onMutate: async (moveInput) => {
      await queryClient.cancelQueries({ queryKey: boardKey(params) });
      const previous = queryClient.getQueryData<Board>(boardKey(params));
      if (previous) queryClient.setQueryData(boardKey(params), applyMove(previous, moveInput));
      return { previous };
    },
    onError: (_error, _move, context) => {
      if (context?.previous) queryClient.setQueryData(boardKey(params), context.previous);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['crm'] }),
  });

  const drop = (event: DragEvent, stageId: string, beforeDealId: string | null) => {
    event.preventDefault();
    event.stopPropagation();
    const dealId = event.dataTransfer.getData('text/plain') || dragging;
    setDragging(null);
    setOverStage(null);
    if (!dealId || dealId === beforeDealId) return;
    move.mutate({ dealId, stageId, beforeDealId });
  };

  if (board.isLoading) {
    return (
      <div className="flex gap-3 overflow-hidden px-4 py-8 sm:px-6" aria-busy="true">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="h-80 w-72 shrink-0 animate-pulse rounded-lg bg-surface-sunken" />
        ))}
      </div>
    );
  }
  if (board.error || !board.data) {
    return (
      <div className="px-4 py-8 sm:px-6">
        <ProblemAlert error={board.error} />
      </div>
    );
  }

  const { columns, currency, pipelines, pipeline } = board.data;
  const openValue = columns
    .filter((c) => c.stage.type === 'OPEN')
    .reduce((sum, c) => sum + c.totalValue, 0);

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-5 py-8">
      <div className="flex flex-wrap items-end justify-between gap-4 px-4 sm:px-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Embudo</h1>
          <p className="mt-1 text-sm text-fg-muted" data-testid="valor-abierto">
            {money(openValue, currency)} en oportunidades abiertas
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {pipelines.length > 1 ? (
            <Select
              aria-label="Embudo"
              value={pipeline.id}
              onChange={(e) => setPipelineId(e.target.value)}
              className="w-48"
            >
              {pipelines.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          ) : null}
          {seesOthers ? (
            <label className="flex h-9 cursor-pointer items-center gap-2 rounded-md border border-border px-3 text-sm">
              <input
                type="checkbox"
                className="size-4 accent-primary"
                checked={mine}
                onChange={(e) => setMine(e.target.checked)}
              />
              Sólo mías
            </label>
          ) : null}
          {canWrite ? (
            <Button onClick={() => setCreating(true)}>
              <Plus aria-hidden />
              Nueva oportunidad
            </Button>
          ) : null}
        </div>
      </div>

      {move.error ? (
        <div className="px-4 sm:px-6">
          <ProblemAlert error={move.error} />
        </div>
      ) : null}

      {/* Columnas: desplazamiento horizontal propio, no de la página. */}
      <div className="overflow-x-auto px-4 pb-2 sm:px-6">
        <ol className="flex min-w-max gap-3" aria-label="Etapas del embudo">
          {columns.map((column) => (
            <li
              key={column.stage.id}
              data-testid={`columna-${column.stage.name}`}
              aria-label={`Etapa ${column.stage.name}`}
              onDragOver={(e) => {
                if (!canWrite) return;
                e.preventDefault();
                setOverStage(column.stage.id);
              }}
              onDragLeave={() => setOverStage((s) => (s === column.stage.id ? null : s))}
              onDrop={(e) => drop(e, column.stage.id, null)}
              className={cn(
                'flex w-72 shrink-0 flex-col rounded-lg border border-border bg-surface-sunken/60',
                overStage === column.stage.id && 'border-primary bg-primary-subtle/40',
              )}
            >
              <ColumnHeader column={column} currency={currency} />
              <ul className="flex min-h-24 flex-col gap-2 p-2">
                {column.deals.map((deal) => (
                  <li
                    key={deal.id}
                    draggable={canWrite && deal.status === 'OPEN'}
                    onDragStart={(e) => {
                      e.dataTransfer.setData('text/plain', deal.id);
                      e.dataTransfer.effectAllowed = 'move';
                      setDragging(deal.id);
                    }}
                    onDragEnd={() => {
                      setDragging(null);
                      setOverStage(null);
                    }}
                    onDragOver={(e) => canWrite && e.preventDefault()}
                    onDrop={(e) => drop(e, column.stage.id, deal.id)}
                    className={cn(dragging === deal.id && 'opacity-40')}
                  >
                    <Card
                      deal={deal}
                      currency={currency}
                      columns={columns}
                      canWrite={canWrite}
                      onOpen={() => setOpenDeal(deal.id)}
                      onMove={(stageId) =>
                        move.mutate({ dealId: deal.id, stageId, beforeDealId: null })
                      }
                    />
                  </li>
                ))}
                {column.deals.length === 0 ? (
                  <li className="grid h-20 place-items-center rounded-md border border-dashed border-border text-xs text-fg-faint">
                    {canWrite ? 'Suelta aquí' : 'Vacía'}
                  </li>
                ) : null}
                {column.totalCount > column.deals.length ? (
                  <li className="text-center text-xs text-fg-muted">
                    y {column.totalCount - column.deals.length} más
                  </li>
                ) : null}
              </ul>
            </li>
          ))}
        </ol>
      </div>

      {openDeal ? (
        <DealDialog
          dealId={openDeal}
          slug={slug}
          currency={currency}
          onClose={() => setOpenDeal(null)}
        />
      ) : null}
      {creating ? (
        <NewDealDialog
          stages={pipeline.stages.filter((s) => s.type === 'OPEN')}
          pipelineId={pipeline.id}
          onClose={() => setCreating(false)}
        />
      ) : null}
    </div>
  );
}

function ColumnHeader({ column, currency }: { column: BoardColumn; currency: string }) {
  return (
    <div className="border-b border-border px-3 py-2.5">
      <div className="flex items-center gap-2">
        <span
          aria-hidden
          className="size-2.5 shrink-0 rounded-full"
          style={{ backgroundColor: column.stage.color }}
        />
        <h2 className="flex-1 truncate text-sm font-semibold">{column.stage.name}</h2>
        <span className="text-xs text-fg-muted" data-testid={`cuenta-${column.stage.name}`}>
          {column.totalCount}
        </span>
      </div>
      <p className="mt-0.5 text-xs text-fg-muted">{money(column.totalValue, currency)}</p>
    </div>
  );
}

function Card({
  deal,
  currency,
  columns,
  canWrite,
  onOpen,
  onMove,
}: {
  deal: DealCard;
  currency: string;
  columns: BoardColumn[];
  canWrite: boolean;
  onOpen: () => void;
  onMove: (stageId: string) => void;
}) {
  return (
    <article
      className={cn(
        'grid gap-2 rounded-md border border-border bg-surface p-3 shadow-xs',
        canWrite && deal.status === 'OPEN' && 'cursor-grab active:cursor-grabbing',
      )}
      data-testid={`oportunidad-${deal.title}`}
    >
      <button
        type="button"
        onClick={onOpen}
        className="text-left text-sm font-medium hover:text-primary hover:underline"
      >
        {deal.title}
      </button>
      <p className="flex items-center justify-between gap-2 text-xs text-fg-muted">
        <span className="font-medium text-fg">{money(deal.value, deal.currency || currency)}</span>
        {deal.owner ? <span className="truncate">{deal.owner.name}</span> : null}
      </p>
      {deal.contact || deal.company ? (
        <p className="truncate text-xs text-fg-muted">
          {[deal.contact?.fullName, deal.company?.name].filter(Boolean).join(' · ')}
        </p>
      ) : null}
      {deal.stalled ? (
        <p className="flex items-center gap-1 text-xs font-medium text-warning">
          <AlertTriangle className="size-3.5" aria-hidden />
          Parada demasiado tiempo
        </p>
      ) : null}
      {canWrite ? (
        <select
          aria-label={`Mover «${deal.title}» a`}
          value={deal.stageId}
          onChange={(e) => onMove(e.target.value)}
          className="h-7 rounded-md border border-border bg-surface px-1.5 text-xs text-fg-muted"
        >
          {columns.map((c) => (
            <option key={c.stage.id} value={c.stage.id}>
              {c.stage.id === deal.stageId ? `En ${c.stage.name}` : `Mover a ${c.stage.name}`}
            </option>
          ))}
        </select>
      ) : null}
    </article>
  );
}

/** Refleja un movimiento en el tablero en memoria, para verlo al instante. */
function applyMove(board: Board, { dealId, stageId, beforeDealId }: Move): Board {
  let moved: DealCard | undefined;
  const columns = board.columns.map((column) => {
    const found = column.deals.find((d) => d.id === dealId);
    if (!found) return column;
    moved = found;
    return {
      ...column,
      deals: column.deals.filter((d) => d.id !== dealId),
      totalCount: column.totalCount - 1,
      totalValue: column.totalValue - found.value,
    };
  });
  if (!moved) return board;
  const card: DealCard = { ...moved, stageId };

  return {
    ...board,
    columns: columns.map((column) => {
      if (column.stage.id !== stageId) return column;
      const deals = [...column.deals];
      const index = beforeDealId ? deals.findIndex((d) => d.id === beforeDealId) : -1;
      if (index >= 0) deals.splice(index, 0, card);
      else deals.push(card);
      return {
        ...column,
        deals,
        totalCount: column.totalCount + 1,
        totalValue: column.totalValue + card.value,
      };
    }),
  };
}
