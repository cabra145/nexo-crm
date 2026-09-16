import { BRAND } from '@nexo/design/brand';
import type { Metadata, Viewport } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import type { ReactNode } from 'react';
import { Providers } from './providers';
import './globals.css';

// Next descarga las fuentes al compilar y las sirve desde el propio dominio:
// el navegador del usuario no hace ninguna petición a Google.
const geistSans = Geist({
  subsets: ['latin', 'latin-ext'],
  variable: '--font-geist-sans',
  display: 'swap',
});
const geistMono = Geist_Mono({
  subsets: ['latin'],
  variable: '--font-geist-mono',
  display: 'swap',
});

export const metadata: Metadata = {
  title: { default: BRAND.fullName, template: `%s · ${BRAND.fullName}` },
  description: BRAND.description,
  applicationName: BRAND.fullName,
  // Hasta que exista una web pública, que no la indexen los buscadores.
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f5f7f6' },
    { media: '(prefers-color-scheme: dark)', color: '#0c1110' },
  ],
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    // suppressHydrationWarning: next-themes pone data-theme en <html> antes de
    // hidratar, para que no haya destello del tema equivocado al cargar.
    <html
      lang="es"
      className={`${geistSans.variable} ${geistMono.variable}`}
      suppressHydrationWarning
    >
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
