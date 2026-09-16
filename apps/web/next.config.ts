import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { loadEnvConfig } from '@next/env';
import type { NextConfig } from 'next';

/**
 * Carga el `.env` de la RAÍZ del monorepo.
 *
 * Next.js sólo busca `.env` en su propia carpeta (apps/web), pero la
 * configuración es una para todo el proyecto. `loadEnvConfig` es el cargador
 * oficial de Next: se le indica la raíz y respeta su orden de prioridad
 * (.env.local, .env.development…). Tiene que ocurrir aquí, antes de compilar,
 * porque las variables NEXT_PUBLIC_* se incrustan en el código en ese momento.
 */
function findWorkspaceRoot(from: string): string {
  let dir = from;
  for (;;) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return from;
    dir = parent;
  }
}
loadEnvConfig(findWorkspaceRoot(process.cwd()), process.env.NODE_ENV !== 'production');

/**
 * Cabeceras de seguridad para todas las respuestas.
 *
 * Pendiente para la Fase 1: la Content-Security-Policy estricta con nonce del
 * plan de arquitectura. Necesita middleware y renderizado dinámico, y conviene
 * definirla junto con las pantallas reales, no antes.
 */
const securityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=()' },
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
];

const nextConfig: NextConfig = {
  // Sin cabecera X-Powered-By: no hay por qué anunciar la tecnología.
  poweredByHeader: false,
  reactStrictMode: true,

  // @nexo/design se consume como código fuente TypeScript (marca y tokens).
  transpilePackages: ['@nexo/design'],

  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
};

export default nextConfig;
