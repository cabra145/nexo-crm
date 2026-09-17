'use client';

import { X } from 'lucide-react';
import { type ReactNode, useEffect, useRef } from 'react';
import { cn } from '@/lib/utils';

/**
 * Diálogo modal sobre `<dialog>` nativo.
 *
 * `showModal()` ya resuelve lo difícil de accesibilidad: bloquea el resto de
 * la página para teclado y lectores de pantalla, mueve el foco dentro, cierra
 * con Escape y lo devuelve al elemento que lo abrió.
 */
export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  className,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      // Clic en el fondo (el propio <dialog>, fuera del panel) cierra.
      onClick={(e) => e.target === ref.current && onClose()}
      aria-labelledby="dialog-title"
      className={cn(
        'm-auto w-[calc(100%-2rem)] max-w-md rounded-lg border border-border bg-surface-raised p-0 text-fg shadow-overlay',
        'backdrop:bg-fg/40 backdrop:backdrop-blur-[2px]',
        className,
      )}
    >
      {open ? (
        <div className="grid gap-5 p-6">
          <div className="flex items-start gap-3">
            <div className="flex-1">
              <h2 id="dialog-title" className="text-lg font-semibold">
                {title}
              </h2>
              {description ? <p className="mt-1 text-sm text-fg-muted">{description}</p> : null}
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Cerrar"
              className="grid size-7 place-items-center rounded-md text-fg-muted hover:bg-surface-sunken hover:text-fg"
            >
              <X className="size-4" aria-hidden />
            </button>
          </div>
          {children}
        </div>
      ) : null}
    </dialog>
  );
}
