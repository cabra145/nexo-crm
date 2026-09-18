import { type Browser, expect, type Page, test } from '@playwright/test';
import {
  alertOf,
  linkFromMail,
  login,
  newAccount,
  registerAndVerify,
  workspaceUrl,
} from './helpers';

/**
 * CRM desde el navegador: crear y editar contactos, buscar, vincular empresas
 * y comprobar que un agente sólo ve los suyos también en la interfaz.
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

/** Alta de contacto por la interfaz. Devuelve el nombre completo. */
async function createContact(
  page: Page,
  slug: string,
  fields: { firstName: string; lastName?: string; email?: string; company?: string },
) {
  await page.goto(`/w/${slug}/contactos`);
  await page
    .getByRole('button', { name: /Nuevo contacto|Crear el primero/ })
    .first()
    .click();
  const dialog = page.getByRole('dialog', { name: 'Nuevo contacto' });
  await dialog.getByLabel('Nombre', { exact: true }).fill(fields.firstName);
  if (fields.lastName) await dialog.getByLabel('Apellidos').fill(fields.lastName);
  if (fields.email) await dialog.getByLabel('Correo').fill(fields.email);
  if (fields.company) {
    await dialog.getByLabel('Nombre de la empresa (texto libre)').fill(fields.company);
  }
  await dialog.getByRole('button', { name: 'Crear contacto' }).click();
  // Al crearlo se abre su ficha: se espera a estar en ella para que quien
  // llama pueda quedarse con su URL.
  await expect(page).toHaveURL(/\/contactos\/[0-9a-f-]{36}$/);
  return [fields.firstName, fields.lastName].filter(Boolean).join(' ');
}

test('crear, buscar y editar un contacto', async ({ browser }) => {
  const owner = await ownerWithWorkspace(browser, 'crm');
  const { page, slug } = owner;

  // --- Vacío ---------------------------------------------------------------
  await page.goto(`/w/${slug}/contactos`);
  await expect(page.getByText('Todavía no hay contactos')).toBeVisible();

  // --- Alta ----------------------------------------------------------------
  const nombre = await createContact(page, slug, {
    firstName: 'Ana',
    lastName: 'Gómez',
    email: `ana-${Date.now()}@cliente.test`,
    company: 'Ferretería El Tornillo',
  });
  // Tras crear se abre la ficha.
  await expect(page.getByRole('heading', { name: nombre })).toBeVisible();
  // El nombre de la empresa aparece bajo el título y en la ficha de datos.
  await expect(page.getByText('Ferretería El Tornillo').first()).toBeVisible();
  await expect(page.getByText('Contacto inicial')).toBeVisible();

  // --- Edición -------------------------------------------------------------
  await page.getByRole('button', { name: 'Editar' }).click();
  const edit = page.getByRole('dialog', { name: 'Editar contacto' });
  await edit.getByLabel('Cargo').fill('Jefa de compras');
  await edit.getByLabel('Etapa').selectOption({ label: 'Cliente' });
  await edit.getByRole('button', { name: 'Guardar' }).click();
  await expect(page.getByText('Jefa de compras').first()).toBeVisible();
  await expect(page.getByText('Cliente', { exact: true })).toBeVisible();

  // --- Búsqueda sin acentos -------------------------------------------------
  await page.goto(`/w/${slug}/contactos`);
  await page.getByLabel('Buscar contactos').fill('gomez');
  await expect(page.getByText(nombre)).toBeVisible();

  await page.getByLabel('Buscar contactos').fill('zzzzz');
  await expect(page.getByText('Ningún contacto coincide')).toBeVisible();

  await owner.context.close();
});

test('un correo repetido avisa de quién lo tiene', async ({ browser }) => {
  const owner = await ownerWithWorkspace(browser, 'duplicado');
  const { page, slug } = owner;
  const correo = `repetido-${Date.now()}@cliente.test`;

  await createContact(page, slug, { firstName: 'Primero', lastName: 'Dueño', email: correo });
  await expect(page.getByRole('heading', { name: 'Primero Dueño' })).toBeVisible();

  await page.goto(`/w/${slug}/contactos`);
  await page.getByRole('button', { name: 'Nuevo contacto' }).click();
  const dialog = page.getByRole('dialog', { name: 'Nuevo contacto' });
  await dialog.getByLabel('Nombre', { exact: true }).fill('Segundo');
  await dialog.getByLabel('Correo').fill(correo);
  await dialog.getByRole('button', { name: 'Crear contacto' }).click();

  await expect(alertOf(page)).toContainText('Ya lo tiene Primero Dueño');
  await expect(dialog).toBeVisible();

  await owner.context.close();
});

test('empresa: vincular un contacto y eliminarla sin perder el contacto', async ({ browser }) => {
  const owner = await ownerWithWorkspace(browser, 'empresa');
  const { page, slug } = owner;
  const empresa = `Distribuidora ${Date.now()}`;

  await page.goto(`/w/${slug}/empresas`);
  await expect(page.getByText('Todavía no hay empresas')).toBeVisible();
  await page
    .getByRole('button', { name: /Nueva empresa|Crear la primera/ })
    .first()
    .click();
  const nueva = page.getByRole('dialog', { name: 'Nueva empresa' });
  await nueva.getByLabel('Nombre').fill(empresa);
  await nueva.getByLabel('Sector').fill('Comercio');
  await nueva.getByRole('button', { name: 'Crear empresa' }).click();
  await expect(page.getByText(empresa)).toBeVisible();

  await createContact(page, slug, { firstName: 'Carlos', lastName: 'Ruiz' });
  await page.getByRole('button', { name: 'Editar' }).click();
  const edit = page.getByRole('dialog', { name: 'Editar contacto' });
  await edit.getByLabel('Empresa', { exact: true }).selectOption({ label: empresa });
  await edit.getByRole('button', { name: 'Guardar' }).click();
  await expect(page.getByRole('link', { name: empresa })).toBeVisible();

  // La ficha de la empresa lista a su gente.
  await page.getByRole('link', { name: empresa }).click();
  await expect(page.getByRole('heading', { name: empresa })).toBeVisible();
  await expect(page.getByRole('link', { name: /Carlos Ruiz/ })).toBeVisible();

  // Al eliminarla, el contacto sigue existiendo con el nombre como texto.
  await page.getByRole('button', { name: 'Eliminar empresa' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Eliminar' }).click();
  await expect(page).toHaveURL(`/w/${slug}/empresas`);
  await expect(page.getByText('Todavía no hay empresas')).toBeVisible();

  await page.goto(`/w/${slug}/contactos`);
  await page.getByText('Carlos Ruiz').first().click();
  await expect(page.getByRole('heading', { name: 'Carlos Ruiz' })).toBeVisible();
  await expect(page.getByText(empresa).first()).toBeVisible();

  await owner.context.close();
});

test('un agente sólo ve sus contactos, también en la interfaz', async ({ browser }) => {
  const owner = await ownerWithWorkspace(browser, 'alcance');
  const { page, slug } = owner;

  const delPropietario = await createContact(page, slug, {
    firstName: 'Cliente',
    lastName: 'Del propietario',
  });
  const urlDelPropietario = page.url();

  // El propietario invita a un agente.
  const agente = newAccount('agente');
  await page.goto(`/w/${slug}/ajustes/equipo`);
  await page.getByRole('button', { name: 'Invitar' }).click();
  const invitar = page.getByRole('dialog', { name: 'Invitar al equipo' });
  await invitar.getByLabel('Correo').fill(agente.email);
  await invitar.getByLabel('Rol').selectOption({ label: 'Agente' });
  const desde = Date.now();
  await invitar.getByRole('button', { name: 'Enviar invitación' }).click();
  await expect(page.getByText(`Invitación enviada a ${agente.email}`)).toBeVisible();
  const enlace = await linkFromMail(agente.email, 'te invita', desde);

  // El agente acepta en su propio navegador y crea un contacto suyo.
  const agenteContext = await browser.newContext();
  const agentePage = await agenteContext.newPage();
  await agentePage.goto(enlace);
  await agentePage.getByLabel('Tu nombre').fill('Agente Nuevo');
  await agentePage.getByLabel('Elige una contraseña').fill(agente.password);
  await agentePage.getByRole('button', { name: 'Aceptar y entrar' }).click();
  await expect(agentePage).toHaveURL(`/w/${slug}`);

  const suyo = await createContact(agentePage, slug, {
    firstName: 'Cliente',
    lastName: 'Del agente',
  });
  await agentePage.goto(`/w/${slug}/contactos`);
  await expect(agentePage.getByText(suyo)).toBeVisible();
  await expect(agentePage.getByText(delPropietario)).toHaveCount(0);

  // Y la ficha ajena, por URL directa, no se abre.
  await agentePage.goto(urlDelPropietario);
  await expect(alertOf(agentePage)).toContainText('no encontrado');
  await expect(agentePage.getByRole('link', { name: 'Volver a contactos' })).toBeVisible();

  // El propietario, en cambio, ve los dos.
  await page.goto(`/w/${slug}/contactos`);
  await expect(page.getByText(delPropietario)).toBeVisible();
  await expect(page.getByText(suyo)).toBeVisible();

  await agenteContext.close();
  await owner.context.close();
});

test('en móvil, el menú lateral navega y nada se sale de la pantalla', async ({ browser }) => {
  const owner = await ownerWithWorkspace(browser, 'movil');
  const { page, slug } = owner;
  await createContact(page, slug, {
    firstName: 'Contacto',
    lastName: 'Con un nombre bastante largo para probar',
    email: `un-correo-larguisimo-de-prueba-${Date.now()}@empresa-con-dominio-largo.test`,
  });

  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto(`/w/${slug}`);
  await page.getByRole('button', { name: 'Abrir el menú' }).click();
  await page.getByRole('link', { name: 'Contactos' }).click();
  await expect(page).toHaveURL(`/w/${slug}/contactos`);
  await expect(page.getByRole('heading', { name: 'Contactos' })).toBeVisible();

  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
    'sin desplazamiento horizontal a 375 px',
  ).toBeLessThanOrEqual(375);

  await owner.context.close();
});

test('tareas y notas de un contacto, y la agenda', async ({ browser }) => {
  const owner = await ownerWithWorkspace(browser, 'agenda');
  const { page, slug } = owner;

  await createContact(page, slug, { firstName: 'Rosa', lastName: 'Villalba' });

  // Cada sección por separado: el título de una tarea aparece también en la
  // historia, y una nota, en su resumen.
  const seccion = (nombre: string) =>
    page.locator('section', { has: page.getByRole('heading', { name: nombre, exact: true }) });
  const tareas = seccion('Tareas');
  const notas = seccion('Notas');
  const historia = seccion('Historia');

  // --- Tarea desde la ficha ------------------------------------------------
  await page.getByLabel('Título de la tarea').fill('Enviar la cotización');
  await page.getByRole('button', { name: 'Añadir' }).click();
  await expect(tareas.getByText('Enviar la cotización')).toBeVisible();
  await expect(page.getByText('Nada pendiente con este contacto.')).toHaveCount(0);

  // --- Nota ----------------------------------------------------------------
  await page.getByLabel('Nueva nota').fill('Prefiere que la llamen por la mañana.');
  await page.getByRole('button', { name: 'Guardar nota' }).click();
  await expect(notas.getByText('Prefiere que la llamen por la mañana.')).toBeVisible();

  // La historia recoge la creación, la tarea y la nota.
  await expect(historia.getByText('Contacto creado')).toBeVisible();
  await expect(historia.getByText('Tarea creada: Enviar la cotización')).toBeVisible();
  await expect(historia.getByText('Nota añadida')).toBeVisible();

  // --- Editar la nota propia ------------------------------------------------
  await notas.getByRole('button', { name: 'Editar' }).click();
  await page.getByLabel('Editar la nota').fill('Prefiere que la llamen por la tarde.');
  await notas.getByRole('button', { name: 'Guardar', exact: true }).click();
  await expect(notas.getByText('Prefiere que la llamen por la tarde.')).toBeVisible();

  // --- La tarea aparece en la agenda y se completa ---------------------------
  await page.goto(`/w/${slug}/tareas`);
  await page.getByRole('tab', { name: 'Sin fecha' }).click();
  // El tramo elegido queda marcado, y sólo él: si el resalte no siguiera al
  // contenido, la agenda mentiría sobre lo que estás viendo.
  await expect(page.getByRole('tab', { name: 'Sin fecha' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(page.getByRole('tab', { name: 'Para hoy' })).toHaveAttribute(
    'aria-selected',
    'false',
  );
  await expect(page.getByText('Enviar la cotización')).toBeVisible();
  await page.getByRole('checkbox', { name: 'Completar «Enviar la cotización»' }).check();
  await expect(page.getByText('Nada por aquí')).toBeVisible();

  await page.getByRole('tab', { name: 'Hechas' }).click();
  await expect(page.getByText('Enviar la cotización')).toBeVisible();

  // Y la historia del contacto lo registra.
  await page.goto(`/w/${slug}/contactos`);
  await page.getByText('Rosa Villalba').first().click();
  await expect(historia.getByText('Tarea completada: Enviar la cotización')).toBeVisible();

  await owner.context.close();
});
