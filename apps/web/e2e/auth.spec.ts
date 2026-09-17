import { expect, test } from '@playwright/test';
import {
  alertOf,
  freshTotp,
  linkFromMail,
  login,
  logout,
  newAccount,
  registerAndVerify,
  workspaceUrl,
} from './helpers';

/**
 * Autenticación desde el navegador: lo que la prueba de la API no puede ver.
 * Cookies reales, redirecciones, estado entre pestañas y recargas.
 */

test('sin sesión, el espacio de trabajo lleva al inicio de sesión y vuelve después', async ({
  page,
}) => {
  await page.goto('/w/una-empresa/ajustes/seguridad');
  await expect(page).toHaveURL('/login?next=%2Fw%2Funa-empresa%2Fajustes%2Fseguridad');
  await expect(page.getByRole('heading', { name: 'Inicia sesión' })).toBeVisible();
});

test('una redirección `next` a otro sitio se ignora', async ({ page }) => {
  const account = newAccount('next');
  await registerAndVerify(page, account);
  await page.goto('/login?next=https%3A%2F%2Fejemplo.com%2Frobo');
  await page.getByLabel('Correo').fill(account.email);
  await page.getByLabel('Contraseña', { exact: true }).fill(account.password);
  await page.getByRole('button', { name: 'Entrar' }).click();
  await expect(page).toHaveURL(workspaceUrl);
});

test('registro, verificación, 2FA completo y entrada con código y con código de recuperación', async ({
  page,
}) => {
  const account = newAccount('2fa');
  const usedSteps = new Set<number>();

  await registerAndVerify(page, account);

  // --- Entrada: propietario sin 2FA, dentro del plazo -------------------------
  await login(page, account.email, account.password);
  await expect(page).toHaveURL(workspaceUrl);
  const home = new URL(page.url()).pathname;
  await expect(page.getByRole('heading', { name: 'Hola, Prueba' })).toBeVisible();
  await expect(page.getByText('Activa la verificación en dos pasos.')).toBeVisible();

  // La sesión sobrevive a una recarga (token en memoria, cookie de refresco).
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Hola, Prueba' })).toBeVisible();

  // --- Activar el 2FA ---------------------------------------------------------
  await page.getByRole('link', { name: 'Activar ahora' }).click();
  await expect(page).toHaveURL(`${home}/ajustes/seguridad`);
  await page.getByRole('button', { name: 'Activar' }).click();

  const secret = (await page.getByTestId('clave-2fa').innerText()).replace(/\s+/g, '');
  expect(secret).toMatch(/^[A-Z2-7]{32,}$/);
  await expect(page.getByRole('img', { name: /Código QR/ })).toBeVisible();

  // Un código incorrecto no activa nada.
  await page.getByLabel(/Escribe el código/).fill('000000');
  await page.getByRole('button', { name: 'Activar' }).click();
  await expect(alertOf(page)).toBeVisible();

  await page.getByLabel(/Escribe el código/).fill(await freshTotp(secret, usedSteps));
  await page.getByRole('button', { name: 'Activar' }).click();

  await expect(
    page.getByRole('heading', { name: 'Guarda tus códigos de recuperación' }),
  ).toBeVisible();
  const codes = await page
    .getByRole('listitem')
    .filter({ hasText: /^[A-Z0-9]{5}-[A-Z0-9]{5}$/ })
    .allInnerTexts();
  expect(codes).toHaveLength(10);

  const finish = page.getByRole('button', { name: 'Terminar' });
  await expect(finish).toBeDisabled();
  await page.getByLabel('He guardado mis códigos en un lugar seguro').check();
  await finish.click();
  await expect(page.getByText(/^Activa\. Además de la contraseña/)).toBeVisible();

  // Con el 2FA activo desaparece el aviso.
  await page.goto(home);
  await expect(page.getByRole('heading', { name: 'Hola, Prueba' })).toBeVisible();
  await expect(page.getByText('Activa la verificación en dos pasos.')).toHaveCount(0);

  // --- Entrar con el autenticador --------------------------------------------
  await logout(page);
  // Cerrar sesión revoca la cookie: volver atrás no reabre el espacio.
  await page.goto(home);
  await expect(page).toHaveURL(/\/login\?next=/);

  await login(page, account.email, account.password);
  await expect(page.getByRole('heading', { name: 'Verificación en dos pasos' })).toBeVisible();
  await page.getByLabel('Código', { exact: true }).fill(await freshTotp(secret, usedSteps));
  await page.getByRole('button', { name: 'Entrar' }).click();
  await expect(page).toHaveURL(home);

  // --- Entrar con un código de recuperación ----------------------------------
  await logout(page);
  await login(page, account.email, account.password);
  await page.getByRole('button', { name: /Usa un código de recuperación/ }).click();
  await page.getByLabel('Código de recuperación').fill(codes[0]!.toLowerCase());
  await page.getByRole('button', { name: 'Entrar' }).click();
  await expect(page).toHaveURL(home);

  // El mismo código de recuperación no sirve dos veces.
  await logout(page);
  await login(page, account.email, account.password);
  await page.getByRole('button', { name: /Usa un código de recuperación/ }).click();
  await page.getByLabel('Código de recuperación').fill(codes[0]!);
  await page.getByRole('button', { name: 'Entrar' }).click();
  await expect(alertOf(page)).toBeVisible();
  await expect(page).toHaveURL(/\/login/);
});

test('varias pestañas que recargan a la vez conservan la sesión', async ({ context }) => {
  const first = await context.newPage();
  const account = newAccount('pestanas');
  await registerAndVerify(first, account);
  await login(first, account.email, account.password);
  await expect(first).toHaveURL(workspaceUrl);
  const home = new URL(first.url()).pathname;

  const tabs = [first, await context.newPage(), await context.newPage()];
  await Promise.all(tabs.slice(1).map((tab) => tab.goto(home)));

  // Todas renuevan a la vez con la misma cookie. Sin coordinación, la segunda
  // renovación parecería una cookie robada y la API cerraría la sesión.
  // Además, cada recarga puede cortar la renovación de la pestaña que tenía el
  // turno DESPUÉS de que la API la procesara: la cookie nueva no llega y el
  // navegador vuelve con la anterior (el margen de reintento de la API).
  // Es una carrera, así que se repite: con 3 rondas fallaba una de cada pocas
  // ejecuciones antes de ese margen.
  const rounds = Number(process.env.E2E_TAB_ROUNDS ?? 10);
  for (let round = 0; round < rounds; round++) {
    await Promise.all(tabs.map((tab) => tab.reload()));
    for (const tab of tabs) {
      await expect(tab.getByRole('heading', { name: 'Hola, Prueba' })).toBeVisible();
    }
  }

  // Y la sesión sigue viva para una pestaña nueva.
  const late = await context.newPage();
  await late.goto(home);
  await expect(late.getByRole('heading', { name: 'Hola, Prueba' })).toBeVisible();
});

test('recuperar la contraseña con el enlace del correo', async ({ page }) => {
  const account = newAccount('recuperar');
  await registerAndVerify(page, account);
  const newPassword = 'Recuperada-2026!';

  const started = Date.now();
  await page.goto('/recuperar');
  await page.getByLabel('Correo').fill(account.email);
  await page.getByRole('button', { name: 'Enviar enlace' }).click();
  await expect(page.getByRole('heading', { name: 'Revisa tu correo' })).toBeVisible();

  const link = await linkFromMail(account.email, 'Restablece', started);
  await page.goto(link);
  await expect(page).not.toHaveURL(/token=/);
  await page.getByLabel('Contraseña nueva').fill(newPassword);
  await page.getByLabel('Repítela').fill(newPassword);
  await page.getByRole('button', { name: 'Guardar contraseña' }).click();
  await expect(page.getByRole('heading', { name: 'Contraseña actualizada' })).toBeVisible();

  // El enlace es de un solo uso.
  await page.goto(link);
  await page.getByLabel('Contraseña nueva').fill('Otra-Distinta-2026!');
  await page.getByLabel('Repítela').fill('Otra-Distinta-2026!');
  await page.getByRole('button', { name: 'Guardar contraseña' }).click();
  await expect(page.getByRole('heading', { name: 'El enlace no funciona' })).toBeVisible();

  // La contraseña antigua ya no entra; la nueva, sí.
  await login(page, account.email, account.password);
  await expect(alertOf(page)).toContainText('Correo o contraseña incorrectos');
  await login(page, account.email, newPassword);
  await expect(page).toHaveURL(workspaceUrl);
});
