import { defineConfig, devices } from '@playwright/test';

/**
 * Pruebas de navegador de la web contra la API REAL.
 *
 * No arranca servidores: los levanta infra/scripts/ci-integration.sh (API,
 * worker, `next start`), igual que en un despliegue. Para lanzarlas a mano
 * contra el entorno de desarrollo:
 *
 *   WEB_URL=http://localhost:3000 MAILPIT_URL=http://localhost:8025 pnpm --filter @nexo/web test:e2e
 */
export default defineConfig({
  testDir: './e2e',
  // Las pruebas comparten API, Redis y buzón: en serie, sin sorpresas.
  workers: 1,
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  // Un reintento: estas pruebas arrancan navegadores contra una API y una base
  // de datos reales, y en una máquina cargada (o en un runner compartido) un
  // clic puede caer sobre un elemento que todavía se está reacomodando. Un
  // fallo real vuelve a fallar en el reintento; la lentitud, no.
  retries: 1,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  outputDir: 'test-results',
  use: {
    baseURL: process.env.WEB_URL ?? 'http://localhost:3000',
    locale: 'es-EC',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  // `channel: 'chromium'`: el Chromium completo en modo headless nuevo, no el
  // «headless shell» reducido. Es el mismo motor que usa la gente (Web Locks,
  // BroadcastChannel, cookies) y ahorra una descarga.
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], channel: 'chromium' } }],
});
