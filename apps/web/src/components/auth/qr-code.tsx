'use client';

import QRCode from 'qrcode';
import { useEffect, useState } from 'react';

/**
 * Código QR del autenticador.
 *
 * Negro sobre blanco SIEMPRE, también en tema oscuro: los lectores de QR de
 * los teléfonos fallan con colores invertidos o de bajo contraste. Es el único
 * lugar del producto con colores literales, y por esa razón.
 */
export function QrCode({ value, label }: { value: string; label: string }) {
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void QRCode.toString(value, {
      type: 'svg',
      margin: 1,
      errorCorrectionLevel: 'M',
      color: { dark: '#000000', light: '#ffffff' },
    }).then((svg) => {
      if (!cancelled) setSrc(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`);
    });
    return () => {
      cancelled = true;
    };
  }, [value]);

  return (
    <div className="grid size-44 place-items-center rounded-lg border border-border bg-white p-2">
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element -- SVG generado en el cliente como data URI: next/image no aporta nada aquí
        <img src={src} alt={label} className="size-full" />
      ) : (
        <span className="size-full animate-pulse rounded bg-neutral-100" />
      )}
    </div>
  );
}
