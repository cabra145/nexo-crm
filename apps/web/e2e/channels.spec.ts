import { createServer, type Server } from 'node:http';
import { expect, test } from '@playwright/test';
import { alertOf, login, newAccount, registerAndVerify, workspaceUrl } from './helpers';

/**
 * Conectar WhatsApp desde la interfaz, contra un simulador de la Graph API de
 * Meta: la API lo consulta al conectar (META_GRAPH_URL apunta aquí).
 */

const TOKEN = `EAAG${'w'.repeat(40)}`;
const PHONE_NUMBER_ID = `2${String(Date.now()).slice(-8)}`;
let graph: Server;

test.beforeAll(async () => {
  const url = new URL(process.env.META_GRAPH_URL ?? 'http://127.0.0.1:44200');
  graph = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      res.statusCode = 401;
      res.end(JSON.stringify({ error: { message: 'Invalid OAuth access token.', code: 190 } }));
      return;
    }
    res.end(
      JSON.stringify({
        id: PHONE_NUMBER_ID,
        display_phone_number: '+593 99 123 4567',
        verified_name: 'Ferretería Prueba',
      }),
    );
  });
  await new Promise<void>((resolve) => graph.listen(Number(url.port), url.hostname, resolve));
});

test.afterAll(async () => {
  await new Promise((resolve) => graph.close(resolve));
});

test('conectar y desconectar un número de WhatsApp', async ({ page }) => {
  const account = newAccount('whatsapp');
  await registerAndVerify(page, account);
  await login(page, account.email, account.password);
  await expect(page).toHaveURL(workspaceUrl);
  const slug = new URL(page.url()).pathname.split('/')[2]!;

  await page.goto(`/w/${slug}/ajustes/canales`);
  await expect(page.getByText('Todavía no hay ningún número conectado')).toBeVisible();

  // --- Datos que Meta rechaza -------------------------------------------------
  await page.getByRole('button', { name: 'Conectar WhatsApp' }).click();
  const dialog = page.getByRole('dialog', { name: 'Conectar WhatsApp Business' });
  await dialog.getByLabel('Identificador del número').fill(PHONE_NUMBER_ID);
  await dialog.getByLabel('Identificador de la cuenta').fill('300000000000001');
  await dialog.getByLabel('Token de acceso').fill(`EAAG${'z'.repeat(40)}`);
  await dialog.getByLabel('Clave secreta de la app').fill('d'.repeat(32));
  await dialog.getByRole('button', { name: 'Conectar' }).click();
  await expect(alertOf(page)).toContainText('Invalid OAuth access token');

  // --- Datos correctos ---------------------------------------------------------
  await dialog.getByLabel('Token de acceso').fill(TOKEN);
  await dialog.getByRole('button', { name: 'Conectar' }).click();
  await expect(dialog).toHaveCount(0);

  const card = page.getByTestId('canal-+593991234567');
  await expect(card).toContainText('Conectado');
  await expect(card).toContainText('Ferretería Prueba en WhatsApp');
  await expect(card.getByTestId('URL del webhook')).toContainText('/api/v1/webhooks/whatsapp/');

  // El token de verificación se ve sólo al pedirlo.
  const token = card.getByTestId('Token de verificación');
  await expect(token).toHaveText('•'.repeat(24));
  await card.getByRole('button', { name: 'Mostrar' }).click();
  await expect(token).not.toHaveText('•'.repeat(24));

  // --- Desconectar -------------------------------------------------------------
  await card.getByRole('button', { name: 'Desconectar' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Desconectar' }).click();
  await expect(page.getByText('Todavía no hay ningún número conectado')).toBeVisible();
});
