import { type Browser, expect, type Page, test } from '@playwright/test';
import {
  linkFromMail,
  login,
  newAccount,
  PASSWORD,
  registerAndVerify,
  workspaceUrl,
} from './helpers';

/**
 * Equipo desde el navegador: invitar, aceptar (con cuenta nueva y con una
 * existente), cambiar el rol y quitar el acceso.
 *
 * Cada persona usa su PROPIO contexto de navegador: cookies y almacenamiento
 * separados, como dos ordenadores distintos.
 */

async function ownerWithWorkspace(browser: Browser, label: string) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const account = newAccount(label);
  await registerAndVerify(page, account);
  await login(page, account.email, account.password);
  await expect(page).toHaveURL(workspaceUrl);
  const slug = new URL(page.url()).pathname.split('/')[2]!;
  return { context, page, account, slug };
}

async function invite(page: Page, slug: string, email: string, role: string, team?: string) {
  await page.goto(`/w/${slug}/ajustes/equipo`);
  await page.getByRole('button', { name: 'Invitar' }).click();
  const dialog = page.getByRole('dialog', { name: 'Invitar al equipo' });
  await dialog.getByLabel('Correo').fill(email);
  await dialog.getByLabel('Rol').selectOption({ label: role });
  if (team) await dialog.getByLabel('Equipo (opcional)').fill(team);
  await dialog.getByRole('button', { name: 'Enviar invitación' }).click();
  await expect(page.getByText(`Invitación enviada a ${email}`)).toBeVisible();
  await expect(page.getByTestId(`invitacion-${email}`)).toBeVisible();
  return linkFromMail(email, 'te invita');
}

test('invitar con cuenta nueva, cambiar el rol y quitar el acceso', async ({ browser }) => {
  const owner = await ownerWithWorkspace(browser, 'equipo');
  const invitee = newAccount('invitada');

  // --- El propietario invita ----------------------------------------------
  const link = await invite(owner.page, owner.slug, invitee.email, 'Agente', 'Norte');
  await expect(owner.page.getByTestId('plazas')).toContainText('2 de 5');

  // --- La invitada acepta desde SU navegador -------------------------------
  const guestContext = await browser.newContext();
  const guest = await guestContext.newPage();
  await guest.goto(link);
  await expect(
    guest.getByRole('heading', { name: `Únete a ${owner.account.company}` }),
  ).toBeVisible();
  await expect(guest.getByText('como Agente')).toBeVisible();
  await expect(guest).not.toHaveURL(/token=/);

  await guest.getByLabel('Tu nombre').fill('Lucía Invitada');
  await guest.getByLabel('Elige una contraseña').fill(invitee.password);
  await guest.getByRole('button', { name: 'Aceptar y entrar' }).click();
  await expect(guest).toHaveURL(`/w/${owner.slug}`);
  await expect(guest.getByRole('heading', { name: 'Hola, Lucía' })).toBeVisible();

  // Un agente ve el equipo, pero no puede invitar.
  await guest.goto(`/w/${owner.slug}/ajustes/equipo`);
  await expect(guest.getByTestId(`miembro-${owner.account.email}`)).toBeVisible();
  await expect(guest.getByRole('button', { name: 'Invitar' })).toHaveCount(0);

  // --- El propietario la ve y le cambia el rol ------------------------------
  await owner.page.reload();
  const row = owner.page.getByTestId(`miembro-${invitee.email}`);
  await expect(row).toContainText('Agente');
  await expect(row).toContainText('Norte');
  await row.getByRole('button', { name: `Acciones para ${invitee.email}` }).click();
  await owner.page.getByRole('menuitem', { name: 'Cambiar rol o equipo' }).click();
  const edit = owner.page.getByRole('dialog');
  await edit.getByLabel('Rol').selectOption({ label: 'Invitado' });
  await edit.getByRole('button', { name: 'Guardar' }).click();
  await expect(row).toContainText('Invitado');

  // En un móvil, la lista no se sale de la pantalla (ni con correos largos).
  await owner.page.setViewportSize({ width: 375, height: 812 });
  await expect(row).toBeVisible();
  expect(
    await owner.page.evaluate(() => document.documentElement.scrollWidth),
    'sin desplazamiento horizontal a 375 px',
  ).toBeLessThanOrEqual(375);
  await owner.page.setViewportSize({ width: 1280, height: 720 });

  // El propietario no tiene menú sobre sí mismo.
  await expect(
    owner.page
      .getByTestId(`miembro-${owner.account.email}`)
      .getByRole('button', { name: /Acciones para/ }),
  ).toHaveCount(0);

  // --- Desactivarla le quita el acceso ------------------------------------
  await row.getByRole('button', { name: `Acciones para ${invitee.email}` }).click();
  await owner.page.getByRole('menuitem', { name: 'Desactivar' }).click();
  await expect(row).toContainText('Desactivado');

  await guest.reload();
  await expect(guest).toHaveURL(/\/login/);

  await guestContext.close();
  await owner.context.close();
});

test('invitar a alguien que ya tiene cuenta: acepta iniciando sesión', async ({ browser }) => {
  const owner = await ownerWithWorkspace(browser, 'anfitrion');

  // Otra persona con su propia empresa (y sin sesión abierta).
  const otherContext = await browser.newContext();
  const other = await otherContext.newPage();
  const existing = newAccount('existente');
  await registerAndVerify(other, existing);

  const link = await invite(owner.page, owner.slug, existing.email, 'Responsable de equipo');

  await other.goto(link);
  await expect(other.getByText('Ya tienes una cuenta con este correo')).toBeVisible();
  await other.getByRole('link', { name: 'Iniciar sesión para aceptar' }).click();
  await expect(other.getByText('Entra con tu cuenta para aceptar la invitación.')).toBeVisible();

  await other.getByLabel('Correo').fill(existing.email);
  await other.getByLabel('Contraseña', { exact: true }).fill(PASSWORD);
  await other.getByRole('button', { name: 'Entrar' }).click();

  // Entra directamente en la empresa que invita, y conserva la suya.
  await expect(other).toHaveURL(`/w/${owner.slug}`);
  await expect(other.getByLabel('Empresa activa')).toBeVisible();

  await owner.page.reload();
  await expect(owner.page.getByTestId(`miembro-${existing.email}`)).toContainText(
    'Responsable de equipo',
  );

  await otherContext.close();
  await owner.context.close();
});

test('un enlace de invitación inválido lo dice claramente', async ({ page }) => {
  await page.goto(`/invitacion?token=${'x'.repeat(43)}`);
  await expect(page.getByRole('heading', { name: 'La invitación no funciona' })).toBeVisible();
});
