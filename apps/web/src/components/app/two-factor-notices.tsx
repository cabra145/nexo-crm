import { ShieldAlert, ShieldCheck } from 'lucide-react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';

function daysLeft(deadline: string | null): number {
  if (!deadline) return 0;
  return Math.max(0, Math.ceil((new Date(deadline).getTime() - Date.now()) / 86_400_000));
}

/** Aviso persistente durante el plazo de 7 días. No se puede cerrar: es obligatorio. */
export function TwoFactorBanner({ slug, deadline }: { slug: string; deadline: string | null }) {
  const days = daysLeft(deadline);
  return (
    <div className="border-b border-warning/30 bg-warning-subtle">
      <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-x-4 gap-y-2 px-6 py-2.5 text-sm">
        <ShieldAlert className="size-4 shrink-0 text-warning" aria-hidden />
        <p className="flex-1">
          <span className="font-medium">Activa la verificación en dos pasos.</span>{' '}
          <span className="text-fg-muted">
            Como propietario, es obligatoria.{' '}
            {days > 1
              ? `Te quedan ${days} días.`
              : days === 1
                ? 'Te queda 1 día.'
                : 'El plazo termina hoy.'}
          </span>
        </p>
        <Button asChild size="sm">
          <Link href={`/w/${slug}/ajustes/seguridad`}>Activar ahora</Link>
        </Button>
      </div>
    </div>
  );
}

/** Plazo vencido: sólo se puede ir a configurarlo. */
export function TwoFactorBlocked({ slug }: { slug: string }) {
  return (
    <main className="flex flex-1 items-start justify-center px-6 pt-[12vh]">
      <div className="w-full max-w-md space-y-6 text-center">
        <div className="mx-auto grid size-12 place-items-center rounded-full bg-warning-subtle">
          <ShieldCheck className="size-6 text-warning" aria-hidden />
        </div>
        <div className="space-y-2">
          <h1 className="text-2xl font-semibold tracking-tight">
            Activa la verificación en dos pasos
          </h1>
          <p className="text-fg-muted">
            Tienes acceso total a los datos de tu empresa, así que tu cuenta necesita una segunda
            protección además de la contraseña. El plazo de 7 días terminó: actívala para seguir.
            Tarda un minuto.
          </p>
        </div>
        <Button asChild size="lg">
          <Link href={`/w/${slug}/ajustes/seguridad`}>Configurar ahora</Link>
        </Button>
      </div>
    </main>
  );
}
