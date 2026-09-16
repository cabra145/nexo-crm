import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Carga el `.env` de la raíz del monorepo. Mismo mecanismo que la API
 * (apps/api/src/bootstrap/load-env.ts): se sube hasta `pnpm-workspace.yaml` y
 * se usa `process.loadEnvFile`, nativo de Node.
 *
 * Está duplicado a propósito y no en @nexo/contracts: ese paquete también lo
 * importa la web, y un módulo con `node:fs` rompería el bundle del navegador.
 *
 * En producción no hay `.env` y no se carga nada: las variables llegan del
 * orquestador.
 */
function findWorkspaceRoot(from: string): string | null {
  let dir = from;
  for (;;) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

const root = findWorkspaceRoot(__dirname);
const envFile = root ? join(root, '.env') : null;

if (envFile && existsSync(envFile)) {
  process.loadEnvFile(envFile);
}
