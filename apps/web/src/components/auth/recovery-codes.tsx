'use client';

import { BRAND } from '@nexo/design/brand';
import { Check, Copy, Download } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';

/**
 * Códigos de recuperación, mostrados UNA sola vez.
 *
 * La API sólo guarda su hash: si el usuario no los guarda ahora, no hay forma
 * de volver a verlos. Por eso se ofrecen copiar y descargar, y la pantalla
 * pide confirmar que están guardados antes de continuar.
 */
export function RecoveryCodes({ codes, account }: { codes: string[]; account: string }) {
  const [copied, setCopied] = useState(false);

  const text = [
    `${BRAND.fullName} · códigos de recuperación`,
    `Cuenta: ${account}`,
    `Generados: ${new Date().toLocaleString('es')}`,
    '',
    'Cada código sirve UNA sola vez para entrar si pierdes el acceso a tu autenticador.',
    'Guárdalos en un gestor de contraseñas. No los compartas.',
    '',
    ...codes,
  ].join('\n');

  return (
    <div className="space-y-3">
      <ol className="grid grid-cols-2 gap-x-6 gap-y-1.5 rounded-lg border border-border bg-surface-sunken px-4 py-3 font-mono text-sm">
        {codes.map((code) => (
          <li key={code} className="tracking-wide text-fg">
            {code}
          </li>
        ))}
      </ol>
      <div className="flex gap-2">
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={() => {
            void navigator.clipboard.writeText(codes.join('\n')).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 2000);
            });
          }}
        >
          {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
          {copied ? 'Copiados' : 'Copiar'}
        </Button>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={() => {
            const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
            const a = document.createElement('a');
            a.href = url;
            a.download = `${BRAND.name.toLowerCase()}-codigos-de-recuperacion.txt`;
            a.click();
            URL.revokeObjectURL(url);
          }}
        >
          <Download aria-hidden />
          Descargar
        </Button>
      </div>
    </div>
  );
}
