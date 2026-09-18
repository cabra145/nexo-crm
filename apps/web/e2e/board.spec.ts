import { type Browser, expect, type Page, test } from '@playwright/test';
import { login, newAccount, registerAndVerify, workspaceUrl } from './helpers';

/**
 * Tablero del embudo desde el navegador: crear, mover con teclado y con el
 * ratón, ganar, y que el tablero no desborde la pantalla en un móvil.
 */

async function ownerWithWorkspace(browser: Browser, label: string) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const account = newAccount(label);
  await registerAndVerify(page, account);
  await login(page, account.email, account.password);
  await expect(page).toHaveURL(workspaceUrl);
  const slug = new URL(page.url()).pathname.split('/')[2]!;
  return { context, page, slug };
}

const column = (page: Page, name: string) => page.getByTestId(`columna-${name}`);

async function createDeal(page: Page, title: string, value: string) {
  await page.getByRole('button', { name: 'Nueva oportunidad' }).click();
  const dialog = page.getByRole('dialog', { name: 'Nueva oportunidad' });
  await dialog.getByLabel('¿Qué se vende?').fill(title);
  await dialog.getByLabel('Valor').fill(value);
  await dialog.getByRole('button', { name: 'Crear oportunidad' }).click();
  await expect(dialog).toHaveCount(0);
}

test('crear, mover con teclado y con el ratón, y ganar', async ({ browser }) => {
  const { context, page, slug } = await ownerWithWorkspace(browser, 'tablero');

  await page.goto(`/w/${slug}/embudo`);
  for (const etapa of ['Nuevo', 'Contactado', 'Calificado', 'Negociación', 'Ganado', 'Perdido']) {
    await expect(column(page, etapa)).toBeVisible();
  }

  // --- Alta ----------------------------------------------------------------
  await createDeal(page, 'Cajas para Norte', '1500');
  await expect(column(page, 'Nuevo').getByText('Cajas para Norte')).toBeVisible();
  await expect(page.getByTestId('cuenta-Nuevo')).toHaveText('1');

  // --- Mover con el selector (teclado, lector de pantalla, móvil) ----------
  await page
    .getByLabel('Mover «Cajas para Norte» a')
    .selectOption({ label: 'Mover a Negociación' });
  await expect(column(page, 'Negociación').getByText('Cajas para Norte')).toBeVisible();
  await expect(page.getByTestId('cuenta-Nuevo')).toHaveText('0');
  await expect(page.getByTestId('cuenta-Negociación')).toHaveText('1');

  // --- Arrastrar con el ratón ---------------------------------------------
  await createDeal(page, 'Tornillos para Sur', '800');
  await expect(column(page, 'Nuevo').getByText('Tornillos para Sur')).toBeVisible();
  await page.getByTestId('oportunidad-Tornillos para Sur').dragTo(column(page, 'Calificado'));
  await expect(column(page, 'Calificado').getByText('Tornillos para Sur')).toBeVisible();
  // Tras recargar sigue ahí: el movimiento llegó a la API, no sólo a la pantalla.
  await page.reload();
  await expect(column(page, 'Calificado').getByText('Tornillos para Sur')).toBeVisible();

  // --- Ganar desde la ficha -------------------------------------------------
  await expect(page.getByTestId('valor-abierto')).toContainText('2300');
  await column(page, 'Negociación').getByRole('button', { name: 'Cajas para Norte' }).click();
  const ficha = page.getByRole('dialog', { name: 'Cajas para Norte' });
  await expect(ficha.getByText('Recorrido')).toBeVisible();
  await ficha.getByRole('button', { name: 'Ganada' }).click();
  await expect(ficha.getByText('Ganada', { exact: true })).toBeVisible();
  await ficha.getByRole('button', { name: 'Cerrar' }).click();

  await expect(column(page, 'Ganado').getByText('Cajas para Norte')).toBeVisible();
  await expect(page.getByTestId('valor-abierto')).toContainText('800');

  await context.close();
});

test('perder con motivo', async ({ browser }) => {
  const { context, page, slug } = await ownerWithWorkspace(browser, 'perder');
  await page.goto(`/w/${slug}/embudo`);
  await createDeal(page, 'Pedido dudoso', '300');

  await column(page, 'Nuevo').getByRole('button', { name: 'Pedido dudoso' }).click();
  const ficha = page.getByRole('dialog', { name: 'Pedido dudoso' });
  await ficha.getByRole('button', { name: 'Perdida' }).click();
  await ficha.getByLabel('Motivo de la pérdida').selectOption({ label: 'Precio' });
  await ficha.getByLabel('Comentario (opcional)').fill('Encontró algo más barato.');
  await ficha.getByRole('button', { name: 'Marcar como perdida' }).click();
  await expect(ficha.getByText('Precio — Encontró algo más barato.')).toBeVisible();
  await ficha.getByRole('button', { name: 'Cerrar' }).click();

  await expect(column(page, 'Perdido').getByText('Pedido dudoso')).toBeVisible();
  await context.close();
});

test('en móvil, el tablero se desplaza dentro de su marco y no desborda la página', async ({
  browser,
}) => {
  const { context, page, slug } = await ownerWithWorkspace(browser, 'tablero-movil');
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto(`/w/${slug}/embudo`);
  await expect(column(page, 'Nuevo')).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
    'sin desplazamiento horizontal de la página a 375 px',
  ).toBeLessThanOrEqual(375);
  await context.close();
});
