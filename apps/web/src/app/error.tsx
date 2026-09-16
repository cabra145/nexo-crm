'use client';

import { useEffect } from 'react';
import { Button } from '@/components/ui/button';

/**
 * Error no controlado al renderizar una pantalla.
 *
 * Muestra el `digest`: es el identificador con el que Next registra el error
 * en el servidor, y lo que el usuario puede darle a soporte. El mensaje
 * técnico no se muestra: en producción Next lo oculta de todos modos.
 */
export default function RouteError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-6 px-6">
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">Algo falló al mostrar esta página</h1>
        <p className="text-fg-muted">
          Vuelve a intentarlo. Si sigue pasando, comparte el identificador de abajo con soporte.
        </p>
        {error.digest ? (
          <p className="font-mono text-xs text-fg-faint">Identificador: {error.digest}</p>
        ) : null}
      </div>
      <div>
        <Button onClick={reset}>Reintentar</Button>
      </div>
    </main>
  );
}
