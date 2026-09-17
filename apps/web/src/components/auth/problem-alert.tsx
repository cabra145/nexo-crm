import { ApiError, ApiUnreachableError } from '@/lib/api/client';
import { Alert } from '@/components/ui/alert';

/**
 * Muestra un error de la API en palabras del usuario.
 *
 * El `detail` de la API ya está escrito para personas (dice qué pasó y qué
 * hacer). El identificador de traza sólo aparece en errores del servidor: en
 * un "contraseña incorrecta" no aporta nada y distrae.
 */
export function ProblemAlert({ error, className }: { error: unknown; className?: string }) {
  if (!error) return null;

  if (error instanceof ApiUnreachableError) {
    return (
      <Alert tone="critical" title="Sin conexión con el servidor" className={className}>
        Comprueba tu conexión e inténtalo de nuevo en unos segundos.
      </Alert>
    );
  }

  if (error instanceof ApiError) {
    return (
      <Alert
        tone={error.status === 429 ? 'warning' : 'critical'}
        title={error.problem.title}
        className={className}
      >
        {error.problem.detail}
        {error.status >= 500 && error.traceId ? (
          <span className="mt-1 block font-mono text-2xs text-fg-faint">
            Referencia: {error.traceId}
          </span>
        ) : null}
      </Alert>
    );
  }

  return (
    <Alert tone="critical" title="Algo falló" className={className}>
      Vuelve a intentarlo. Si sigue pasando, recarga la página.
    </Alert>
  );
}
