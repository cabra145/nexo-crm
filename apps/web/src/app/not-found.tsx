import Link from 'next/link';
import { Button } from '@/components/ui/button';

export default function NotFound() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-6 px-6">
      <div className="space-y-2">
        <p className="font-mono text-xs text-fg-faint">404</p>
        <h1 className="text-2xl font-semibold tracking-tight">Esta página no existe</h1>
        <p className="text-fg-muted">
          La dirección puede estar mal escrita, o la página se movió. Si llegaste desde un enlace
          del producto, avísanos.
        </p>
      </div>
      <div>
        <Button asChild variant="secondary">
          <Link href="/">Volver al inicio</Link>
        </Button>
      </div>
    </main>
  );
}
