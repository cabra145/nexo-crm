'use client';

import { BRAND, copyrightLine } from '@nexo/design/brand';
import { useQuery } from '@tanstack/react-query';
import { ArrowUpRight, RefreshCw } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useState } from 'react';
import { ThemeToggle } from '@/components/theme-toggle';
import { Button } from '@/components/ui/button';
import { ApiError, ApiUnreachableError, apiFetch } from '@/lib/api/client';
import { publicEnv } from '@/lib/env';
import { cn } from '@/lib/utils';

/* ========================================================================== */
/*  Datos                                                                      */
/* ========================================================================== */

interface Check {
  status: 'up' | 'down' | 'disabled';
  latencyMs?: number;
  detail?: string;
}

interface Readiness {
  status: 'ready' | 'degraded';
  checks: {
    database: Check;
    redis: Check;
    tenantIsolation: Check;
    /** Informativo: no cambia el estado general (ver la sonda en la API). */
    storage?: Check;
  };
  timestamp?: string;
}

const REFRESH_MS = 10_000;

/** Qué es cada dependencia, en palabras de quien la opera. */
const DEPENDENCIES: Array<{ key: keyof Readiness['checks']; name: string; description: string }> = [
  {
    key: 'database',
    name: 'Base de datos',
    description: 'PostgreSQL con el rol de aplicación, sin permisos para saltarse el aislamiento',
  },
  {
    key: 'redis',
    name: 'Redis',
    description: 'Colas de trabajo, caché y límite de peticiones',
  },
  {
    key: 'tenantIsolation',
    name: 'Aislamiento entre empresas',
    description: 'Políticas RLS activas y forzadas en todas las tablas con datos de empresa',
  },
  {
    key: 'storage',
    name: 'Almacenamiento de archivos',
    description: 'Adjuntos e imágenes, en un bucket privado compatible con S3',
  },
];

function useReadiness() {
  return useQuery({
    queryKey: ['health', 'ready'],
    // 503 NO es un error aquí: es la respuesta que dice qué dependencia falla,
    // y eso es justo lo que esta pantalla tiene que mostrar.
    queryFn: () => apiFetch<Readiness>('/health/ready', { acceptStatus: [503], cache: 'no-store' }),
    refetchInterval: REFRESH_MS,
    retry: false,
    staleTime: 0,
  });
}

/** "hace 4 s", recalculado cada segundo. */
function useSecondsSince(timestamp: number) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(id);
  }, []);
  return timestamp ? Math.max(0, Math.round((now - timestamp) / 1_000)) : null;
}

/* ========================================================================== */
/*  Piezas                                                                     */
/* ========================================================================== */

type Tone = 'positive' | 'warning' | 'critical' | 'neutral';

const TONE: Record<Tone, { dot: string; pill: string }> = {
  positive: { dot: 'bg-positive', pill: 'bg-positive-subtle text-positive' },
  warning: { dot: 'bg-warning', pill: 'bg-warning-subtle text-warning' },
  critical: { dot: 'bg-critical', pill: 'bg-critical-subtle text-critical' },
  neutral: { dot: 'bg-fg-faint', pill: 'bg-surface-sunken text-fg-muted' },
};

/** Estado codificado dos veces, en color y en texto: no depende sólo del color. */
function StatusPill({
  tone,
  label,
  pulse = false,
}: {
  tone: Tone;
  label: string;
  pulse?: boolean;
}) {
  return (
    <AnimatePresence mode="wait" initial={false}>
      <motion.span
        key={label}
        initial={{ opacity: 0, y: 2 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -2 }}
        transition={{ duration: 0.15 }}
        className={cn(
          'inline-flex h-6 items-center gap-1.5 rounded-full px-2.5 text-xs font-medium',
          TONE[tone].pill,
        )}
      >
        <span className="relative flex size-1.5">
          {pulse ? (
            <span
              className={cn(
                'absolute inset-0 animate-ping rounded-full opacity-60',
                TONE[tone].dot,
              )}
            />
          ) : null}
          <span className={cn('relative size-1.5 rounded-full', TONE[tone].dot)} />
        </span>
        {label}
      </motion.span>
    </AnimatePresence>
  );
}

function BrandMark() {
  return (
    <div className="flex items-center gap-2">
      <span
        aria-hidden
        className="grid size-6 place-items-center rounded-md bg-primary text-2xs font-semibold text-fg-on-primary"
      >
        {BRAND.name.charAt(0)}
      </span>
      <span className="text-sm font-semibold tracking-tight">{BRAND.fullName}</span>
    </div>
  );
}

/* ========================================================================== */
/*  Vista                                                                      */
/* ========================================================================== */

export function StatusView() {
  const { data, error, isPending, isFetching, dataUpdatedAt, errorUpdatedAt, refetch } =
    useReadiness();
  const secondsAgo = useSecondsSince(Math.max(dataUpdatedAt, errorUpdatedAt));
  const apiOrigin = new URL(publicEnv.NEXT_PUBLIC_API_URL).origin;
  const isDevelopment = process.env.NODE_ENV === 'development';

  // --- Resumen: un único estado que se lee de un vistazo -----------------
  let summary: { tone: Tone; label: string; pulse?: boolean };
  if (isPending) summary = { tone: 'neutral', label: 'Comprobando…', pulse: true };
  else if (error) summary = { tone: 'critical', label: 'Sin conexión' };
  else if (data?.status === 'ready') summary = { tone: 'positive', label: 'Operativo' };
  else summary = { tone: 'warning', label: 'Degradado' };

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="border-b border-border">
        <div className="mx-auto flex h-14 max-w-3xl items-center justify-between px-6">
          <BrandMark />
          <ThemeToggle />
        </div>
      </header>

      <main className="mx-auto w-full max-w-3xl flex-1 px-6 py-12">
        {isDevelopment ? (
          <p className="mb-2 text-2xs font-medium tracking-wide text-fg-faint uppercase">
            Entorno de desarrollo
          </p>
        ) : null}

        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="space-y-3">
            <h1 className="text-3xl font-semibold">Estado del sistema</h1>
            <div className="flex flex-wrap items-center gap-3">
              <StatusPill {...summary} />
              <span className="text-xs text-fg-faint">
                {secondsAgo === null
                  ? `Se actualiza cada ${REFRESH_MS / 1_000} s`
                  : `Comprobado hace ${secondsAgo} s · se actualiza cada ${REFRESH_MS / 1_000} s`}
              </span>
            </div>
          </div>

          <Button
            variant="secondary"
            size="sm"
            onClick={() => void refetch()}
            disabled={isFetching}
          >
            <RefreshCw className={cn(isFetching && 'animate-spin')} aria-hidden />
            {isFetching ? 'Comprobando' : 'Comprobar ahora'}
          </Button>
        </div>

        {/* --- Detalle ---------------------------------------------------- */}
        <section
          aria-label="Dependencias"
          className="mt-8 overflow-hidden rounded-lg border border-border bg-surface"
        >
          {error ? (
            <ConnectionError error={error} apiUrl={publicEnv.NEXT_PUBLIC_API_URL} />
          ) : (
            <ul className="divide-y divide-border">
              {DEPENDENCIES.map((dep) => {
                const check = data?.checks[dep.key];
                return (
                  <li key={dep.key} className="flex items-start justify-between gap-6 px-5 py-4">
                    <div className="min-w-0 space-y-0.5">
                      <p className="font-medium">{dep.name}</p>
                      <p className="text-sm text-fg-muted">{dep.description}</p>
                      {check?.status === 'down' && check.detail ? (
                        <p className="pt-1 font-mono text-xs break-words text-critical">
                          {check.detail}
                        </p>
                      ) : null}
                    </div>

                    <div className="flex shrink-0 items-center gap-4 pt-0.5">
                      {isPending ? (
                        <>
                          <span className="h-3 w-10 animate-pulse rounded bg-surface-sunken" />
                          <span className="h-6 w-20 animate-pulse rounded-full bg-surface-sunken" />
                        </>
                      ) : check ? (
                        <>
                          <span className="w-14 text-right font-mono text-xs text-fg-faint">
                            {check.latencyMs !== undefined ? `${check.latencyMs} ms` : '—'}
                          </span>
                          <StatusPill
                            tone={
                              check.status === 'up'
                                ? 'positive'
                                : check.status === 'disabled'
                                  ? 'neutral'
                                  : 'critical'
                            }
                            label={
                              check.status === 'up'
                                ? 'Operativo'
                                : check.status === 'disabled'
                                  ? 'Desactivado'
                                  : 'Caído'
                            }
                          />
                        </>
                      ) : null}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        {/* --- Accesos de desarrollo ---------------------------------------- */}
        {isDevelopment ? (
          <section aria-labelledby="dev-links" className="mt-12">
            <h2 id="dev-links" className="text-sm font-semibold">
              Herramientas locales
            </h2>
            <ul className="mt-3 grid gap-px overflow-hidden rounded-lg border border-border bg-border sm:grid-cols-2">
              {[
                {
                  href: `${apiOrigin}/api/docs`,
                  label: 'Documentación de la API',
                  hint: 'OpenAPI · Swagger',
                },
                { href: 'http://localhost:8025', label: 'Correos capturados', hint: 'Mailpit' },
                {
                  href: 'http://localhost:9001',
                  label: 'Almacenamiento de archivos',
                  hint: 'Consola de MinIO',
                },
                {
                  href: `${apiOrigin}/api/docs/openapi.json`,
                  label: 'Especificación OpenAPI',
                  hint: 'JSON',
                },
              ].map((link) => (
                <li key={link.href} className="bg-surface">
                  <a
                    href={link.href}
                    target="_blank"
                    rel="noreferrer"
                    className="group flex items-center justify-between gap-3 px-4 py-3 transition-colors hover:bg-surface-sunken"
                  >
                    <span className="min-w-0">
                      <span className="block text-sm font-medium">{link.label}</span>
                      <span className="block text-xs text-fg-faint">{link.hint}</span>
                    </span>
                    <ArrowUpRight
                      className="size-4 shrink-0 text-fg-faint transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5"
                      aria-hidden
                    />
                  </a>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </main>

      <footer className="border-t border-border">
        <div className="mx-auto flex h-12 max-w-3xl items-center justify-between px-6 text-xs text-fg-faint">
          <span>{copyrightLine()}</span>
          <span className="font-mono">{apiOrigin.replace(/^https?:\/\//, '')}</span>
        </div>
      </footer>
    </div>
  );
}

/* -------------------------------------------------------------------------- */

function ConnectionError({ error, apiUrl }: { error: Error; apiUrl: string }) {
  if (error instanceof ApiUnreachableError) {
    return (
      <div className="space-y-2 px-5 py-6">
        <p className="font-medium">No se puede conectar con la API</p>
        <p className="text-sm text-fg-muted">
          No hubo respuesta en <span className="font-mono text-fg">{apiUrl}</span>. Comprueba que
          esté arrancada: desde la raíz del proyecto,{' '}
          <span className="font-mono text-fg">pnpm dev</span>.
        </p>
      </div>
    );
  }

  if (error instanceof ApiError) {
    return (
      <div className="space-y-2 px-5 py-6">
        <p className="font-medium">{error.problem.title}</p>
        {error.problem.detail ? (
          <p className="text-sm text-fg-muted">{error.problem.detail}</p>
        ) : null}
        {error.traceId ? (
          <p className="font-mono text-xs text-fg-faint">Identificador de traza: {error.traceId}</p>
        ) : null}
      </div>
    );
  }

  return (
    <div className="space-y-2 px-5 py-6">
      <p className="font-medium">No se pudo comprobar el estado</p>
      <p className="text-sm text-fg-muted">{error.message}</p>
    </div>
  );
}
