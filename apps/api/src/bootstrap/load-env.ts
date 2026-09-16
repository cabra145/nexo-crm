import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Carga el `.env` de la RAÍZ del monorepo.
 *
 * La API se ejecuta con el directorio de trabajo en `apps/api`, así que un
 * `dotenv` normal buscaría `apps/api/.env`, que no existe: la configuración es
 * una sola para todo el proyecto. Aquí se sube por el árbol hasta encontrar
 * `pnpm-workspace.yaml` y se carga el `.env` de ahí.
 *
 * Usa `process.loadEnvFile`, nativo de Node desde la 21.7: sin dependencias.
 *
 * En producción no hay `.env`: las variables llegan del orquestador (Docker
 * Compose), y este módulo simplemente no encuentra nada que cargar.
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
  // No sobrescribe variables que ya existan en el entorno: lo que defina el
  // sistema o el orquestador siempre gana sobre el archivo.
  process.loadEnvFile(envFile);
}
