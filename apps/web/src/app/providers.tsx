'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MotionConfig } from 'motion/react';
import { ThemeProvider } from 'next-themes';
import { type ReactNode, useState } from 'react';
import { ApiError } from '@/lib/api/client';

/**
 * Proveedores globales de la parte cliente.
 *
 *   React Query  → TODO dato que viene de la API. Regla del proyecto: nada que
 *                  venga del servidor se copia a un store de estado local.
 *   next-themes  → tema claro/oscuro/sistema, en el atributo data-theme.
 *   MotionConfig → respeta "reducir movimiento" del sistema operativo.
 */
export function Providers({ children }: { children: ReactNode }) {
  // Un QueryClient por sesión de navegador, creado una vez. Si se creara a
  // nivel de módulo, en el servidor lo compartirían peticiones de usuarios
  // distintos.
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 30_000,
            refetchOnWindowFocus: false,
            // Un error 4xx es una respuesta, no un fallo transitorio:
            // reintentarlo da el mismo resultado. Sólo se reintenta lo demás.
            retry: (failureCount, error) =>
              !(error instanceof ApiError && error.status >= 400 && error.status < 500) && failureCount < 2,
          },
        },
      }),
  );

  return (
    <ThemeProvider attribute="data-theme" defaultTheme="system" enableSystem disableTransitionOnChange>
      <QueryClientProvider client={queryClient}>
        <MotionConfig reducedMotion="user">{children}</MotionConfig>
      </QueryClientProvider>
    </ThemeProvider>
  );
}
