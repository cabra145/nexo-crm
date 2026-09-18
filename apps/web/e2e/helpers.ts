import { createHmac } from 'node:crypto';
import { type Page, expect } from '@playwright/test';

export const MAILPIT = process.env.MAILPIT_URL ?? 'http://localhost:8025';
export const PASSWORD = 'Navegador-2026!';

const run = Date.now().toString(36);
let counter = 0;

/** Datos únicos por prueba: la base de CI es compartida por toda la ejecución. */
export function newAccount(label: string) {
  counter += 1;
  const id = `${run}${counter}`;
  return {
    name: `Prueba ${label}`,
    email: `web-${label}-${id}@nexo.test`,
    company: `Web ${label} ${id}`,
    password: PASSWORD,
  };
}
export type Account = ReturnType<typeof newAccount>;

/* --- Correo ---------------------------------------------------------------- */

interface MailpitMessage {
  ID: string;
  Subject: string;
  To: Array<{ Address: string }>;
}

/**
 * Correos ya leídos. Uno «nuevo» es uno que la prueba no ha consumido, no uno
 * con hora posterior: la hora de Mailpit (en la máquina virtual de Docker) y
 * la del sistema se desfasan tras una suspensión del equipo.
 */
const consumed = new Set<string>();

/** Espera el correo más reciente, aún no leído, para `to` y devuelve su enlace. */
export async function linkFromMail(to: string, subject: string): Promise<string> {
  // 30 s: el correo pasa por la cola y el worker, que en una máquina cargada
  // pueden tardar bastante más de lo habitual.
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    // Mailpit devuelve primero los más recientes.
    const res = await fetch(`${MAILPIT}/api/v1/messages?limit=200`);
    const { messages = [] } = (await res.json()) as { messages?: MailpitMessage[] };
    const found = messages.find(
      (m) =>
        !consumed.has(m.ID) && m.To.some((t) => t.Address === to) && m.Subject.includes(subject),
    );
    if (found) {
      consumed.add(found.ID);
      const detail = (await (await fetch(`${MAILPIT}/api/v1/message/${found.ID}`)).json()) as {
        Text: string;
      };
      const url = /https?:\/\/\S+token=[A-Za-z0-9_-]+/.exec(detail.Text)?.[0];
      if (!url) throw new Error(`El correo «${found.Subject}» no trae enlace`);
      // Se navega por la ruta: el origen del enlace es APP_URL, que en CI es el mismo.
      const { pathname, search } = new URL(url);
      return pathname + search;
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`No llegó el correo «${subject}» a ${to}`);
}

/* --- TOTP (RFC 6238), sólo para las pruebas -------------------------------- */

function base32Decode(input: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of input.replace(/[\s=]/g, '').toUpperCase()) {
    value = (value << 5) | alphabet.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

const stepNow = () => Math.floor(Date.now() / 30_000);

function totpAt(secret: string, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const hmac = createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const offset = hmac[hmac.length - 1]! & 15;
  const code = (hmac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return code.toString().padStart(6, '0');
}

/**
 * Código TOTP de un paso de 30 s que todavía no se haya usado.
 *
 * La API rechaza reutilizar el código de un paso (protección contra
 * repetición), así que tras usar uno hay que esperar al siguiente.
 */
export async function freshTotp(secret: string, usedSteps: Set<number>): Promise<string> {
  // Con menos de 3 s de margen el código podría caducar en tránsito.
  while (usedSteps.has(stepNow()) || 30_000 - (Date.now() % 30_000) < 3_000) {
    await new Promise((r) => setTimeout(r, 500));
  }
  const step = stepNow();
  usedSteps.add(step);
  return totpAt(secret, step);
}

/* --- Flujos de pantalla ----------------------------------------------------- */

/** Registro por la interfaz + verificación con el enlace del correo. Devuelve el slug. */
export async function registerAndVerify(page: Page, account: Account): Promise<void> {
  await page.goto('/registro');
  await page.getByLabel('Tu nombre').fill(account.name);
  await page.getByLabel('Correo de trabajo').fill(account.email);
  await page.getByLabel('Nombre de la empresa').fill(account.company);
  await page.getByLabel('Contraseña', { exact: true }).fill(account.password);
  await page.getByRole('button', { name: 'Crear mi empresa' }).click();

  await expect(page).toHaveURL(/\/registro\/revisa-tu-correo$/);
  await expect(page.getByText(account.email)).toBeVisible();

  await page.goto(await linkFromMail(account.email, 'Confirma'));
  await expect(page.getByRole('heading', { name: 'Correo confirmado' })).toBeVisible();
  // El token de un solo uso no se queda en la barra de direcciones.
  await expect(page).not.toHaveURL(/token=/);
}

export async function login(page: Page, email: string, password: string): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Correo').fill(email);
  await page.getByLabel('Contraseña', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Entrar' }).click();
}

export async function logout(page: Page): Promise<void> {
  await page.getByRole('button', { name: /^Menú de / }).click();
  await page.getByRole('menuitem', { name: 'Cerrar sesión' }).click();
  await expect(page).toHaveURL(/\/login$/);
}

export const workspaceUrl = /\/w\/[a-z0-9-]+$/;

/** Alertas de la pantalla, sin el anunciador de rutas de Next (también es role=alert). */
export const alertOf = (page: Page) =>
  page.locator('[role="alert"]:not(#__next-route-announcer__)');
