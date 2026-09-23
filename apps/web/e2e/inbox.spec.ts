import { createHash, createHmac, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { expect, type Page, test } from '@playwright/test';
import { login, newAccount, registerAndVerify, workspaceUrl } from './helpers';

/**
 * Bandeja de entrada en el navegador, con un simulador de Meta: conecta el
 * número, «Meta» envía mensajes firmados al webhook y la bandeja los muestra
 * SIN recargar (tiempo real). Responder los envía al simulador.
 */

const TOKEN = `EAAG${'b'.repeat(40)}`;
const SECRET = 'f'.repeat(32);
/** Un número por prueba: cada uno sólo se puede conectar en una empresa. */
const phoneNumberId = (n: number) => `4${String(Date.now()).slice(-7)}${n}`;
const displayOf = (id: string) => `+59399555${id.slice(-4)}`;
const CLIENT = `5939${String(Date.now()).slice(-7)}`;
const LATE_CLIENT = `5938${String(Date.now()).slice(-7)}`;
const sentToMeta: Array<{ to: string; body: string }> = [];
/** Archivos que el agente sube a Meta, y el que «envía» el cliente. */
const uploadsToMeta: Buffer[] = [];
/** Un PNG de verdad (1×1): el navegador tiene que poder PINTARLO. */
const CLIENT_PHOTO = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
let graph: Server;
let seq = 0;

test.beforeAll(async () => {
  const url = new URL(process.env.META_GRAPH_URL ?? 'http://127.0.0.1:44200');
  graph = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      res.statusCode = 401;
      res.end(JSON.stringify({ error: { message: 'Invalid OAuth access token.', code: 190 } }));
      return;
    }
    const path = new URL(req.url ?? '/', url).pathname.split('/').filter(Boolean);
    if (req.method === 'GET') {
      // El contenido va PRIMERO: /descargas/{id} y /{version}/{id} comparten
      // la posición del identificador en el camino.
      if (path[0] === 'descargas') {
        res.setHeader('content-type', 'image/png');
        res.end(CLIENT_PHOTO);
        return;
      }
      // Datos del archivo que envía el cliente.
      if (path[1] === 'media-del-cliente') {
        res.end(
          JSON.stringify({
            url: `${url.origin}/descargas/media-del-cliente`,
            mime_type: 'image/png',
            sha256: createHash('sha256').update(CLIENT_PHOTO).digest('hex'),
            file_size: CLIENT_PHOTO.length,
          }),
        );
        return;
      }
      const id = path[1]!;
      res.end(
        JSON.stringify({ id, display_phone_number: displayOf(id), verified_name: 'Tienda Web' }),
      );
      return;
    }
    // El agente sube un archivo a Meta.
    if (path[2] === 'media') {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        uploadsToMeta.push(Buffer.concat(chunks));
        res.end(JSON.stringify({ id: `meta-media-${uploadsToMeta.length}` }));
      });
      return;
    }
    let raw = '';
    req.on('data', (chunk: Buffer) => (raw += chunk.toString()));
    req.on('end', () => {
      const payload = JSON.parse(raw) as {
        to: string;
        type?: string;
        text?: { body: string };
        image?: { caption?: string };
      };
      sentToMeta.push({ to: payload.to, body: payload.text?.body ?? payload.image?.caption ?? '' });
      res.end(JSON.stringify({ messages: [{ id: `wamid.web.${Date.now()}.${++seq}` }] }));
    });
  });
  await new Promise<void>((resolve) => graph.listen(Number(url.port), url.hostname, resolve));
});

test.afterAll(async () => {
  await new Promise((resolve) => graph.close(resolve));
});

/** «Meta» envía un mensaje del cliente al webhook del canal, firmado. */
async function clientWrites(
  channel: { webhookUrl: string; phoneNumberId: string },
  from: string,
  text: string,
  secondsAgo = 0,
  photo = false,
) {
  const raw = JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'waba',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: {
                display_phone_number: '593995550000',
                phone_number_id: channel.phoneNumberId,
              },
              contacts: [{ wa_id: from, profile: { name: 'Lucía Paredes' } }],
              messages: [
                {
                  from,
                  id: `wamid.in.${Date.now()}.${++seq}`,
                  timestamp: String(Math.floor(Date.now() / 1000) - secondsAgo),
                  ...(photo
                    ? {
                        type: 'image',
                        image: { id: 'media-del-cliente', mime_type: 'image/png', caption: text },
                      }
                    : { type: 'text', text: { body: text } }),
                },
              ],
            },
          },
        ],
      },
    ],
  });
  const res = await fetch(channel.webhookUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-hub-signature-256': `sha256=${createHmac('sha256', SECRET).update(raw).digest('hex')}`,
    },
    body: raw,
  });
  expect(res.status).toBe(200);
}

async function connectNumber(
  page: Page,
  slug: string,
  id: string,
): Promise<{ webhookUrl: string; phoneNumberId: string }> {
  await page.goto(`/w/${slug}/ajustes/canales`);
  await page.getByRole('button', { name: 'Conectar WhatsApp' }).click();
  const dialog = page.getByRole('dialog', { name: 'Conectar WhatsApp Business' });
  await dialog.getByLabel('Identificador del número').fill(id);
  await dialog.getByLabel('Identificador de la cuenta').fill('300000000000002');
  await dialog.getByLabel('Token de acceso').fill(TOKEN);
  await dialog.getByLabel('Clave secreta de la app').fill(SECRET);
  await dialog.getByRole('button', { name: 'Conectar' }).click();
  const url = page.getByTestId(`canal-${displayOf(id)}`).getByTestId('URL del webhook');
  await expect(url).toContainText('/api/v1/webhooks/whatsapp/');
  return { webhookUrl: (await url.textContent())!.trim(), phoneNumberId: id };
}

test('recibir en tiempo real, tomar, responder y resolver', async ({ page }) => {
  const account = newAccount('bandeja');
  await registerAndVerify(page, account);
  await login(page, account.email, account.password);
  await expect(page).toHaveURL(workspaceUrl);
  const slug = new URL(page.url()).pathname.split('/')[2]!;
  const channel = await connectNumber(page, slug, phoneNumberId(1));

  await page.getByRole('link', { name: 'Bandeja' }).click();
  await expect(page.getByText('En vivo')).toBeVisible();
  await expect(page.getByText('Aún no hay conversaciones')).toBeVisible();

  // --- Llega un mensaje: aparece sin recargar ---------------------------------
  await clientWrites(channel, CLIENT, '¿Tienen envío a Cuenca?');
  const item = page.getByTestId(`conversacion-+${CLIENT}`);
  await expect(item).toBeVisible();
  await expect(item).toContainText('Lucía Paredes');
  await expect(item).toContainText('Sin asignar');
  await expect(item.getByLabel('1 sin leer')).toBeVisible();
  await expect(page.getByRole('tab', { name: /Sin asignar/ })).toContainText('1');

  // --- Abrirla: se marca leída --------------------------------------------------
  await item.click();
  await expect(page).toHaveURL(/[?&]c=/);
  const thread = page.getByRole('log', { name: 'Mensajes' });
  await expect(thread).toContainText('¿Tienen envío a Cuenca?');
  await expect(item.getByLabel('1 sin leer')).toHaveCount(0);

  // --- Tomarla ------------------------------------------------------------------
  await page.getByRole('button', { name: 'Tomar' }).click();
  await expect(page.getByLabel('Asignada a')).toHaveValue(/.+/);
  await expect(item).toContainText('Lleva:');

  // --- Responder con Intro --------------------------------------------------------
  const composer = page.getByLabel('Mensaje', { exact: true });
  await composer.fill('Sí, enviamos a todo el país.');
  await composer.press('Enter');
  await expect(composer).toHaveValue('');
  const reply = thread.getByTestId('mensaje').filter({ hasText: 'Sí, enviamos a todo el país.' });
  await expect(reply).toHaveAttribute('data-direction', 'saliente');
  // El worker lo envía a Meta y el aviso en tiempo real actualiza el estado.
  await expect(reply).toHaveAttribute('data-status', 'SENT');
  expect(sentToMeta).toContainEqual({ to: CLIENT, body: 'Sí, enviamos a todo el país.' });

  // --- El cliente contesta: aparece en el hilo abierto ---------------------------
  await clientWrites(channel, CLIENT, 'Perfecto, gracias');
  await expect(thread).toContainText('Perfecto, gracias');

  // --- Resolver -------------------------------------------------------------------
  await page.getByRole('button', { name: 'Resolver' }).click();
  await expect(page.getByRole('button', { name: 'Reabrir' })).toBeVisible();
  await expect(item).toHaveCount(0);
  await page.getByLabel('Estado').selectOption('resolved');
  await expect(item).toBeVisible();

  // --- Fuera de la ventana de 24 h no se puede escribir texto libre ---------------
  await page.getByLabel('Estado').selectOption('open');
  await clientWrites(channel, LATE_CLIENT, 'Hola, ¿siguen abiertos?', 25 * 3600);
  await page.getByTestId(`conversacion-+${LATE_CLIENT}`).click();
  await expect(page.getByText('Pasaron más de 24 horas desde su último mensaje')).toBeVisible();
  await expect(page.getByLabel('Mensaje', { exact: true })).toHaveCount(0);
});

test('archivos: el cliente envía una foto y el agente adjunta un documento', async ({ page }) => {
  const account = newAccount('archivos');
  await registerAndVerify(page, account);
  await login(page, account.email, account.password);
  await expect(page).toHaveURL(workspaceUrl);
  const slug = new URL(page.url()).pathname.split('/')[2]!;
  const channel = await connectNumber(page, slug, phoneNumberId(3));
  const client = `5937${String(Date.now()).slice(-7)}`;

  await page.goto(`/w/${slug}/bandeja`);
  await expect(page.getByText('En vivo')).toBeVisible();

  // --- El cliente manda una foto ------------------------------------------------
  await clientWrites(channel, client, 'Así llegó el pedido', 0, true);
  await page.getByTestId(`conversacion-+${client}`).click();
  const thread = page.getByRole('log', { name: 'Mensajes' });
  await expect(thread).toContainText('Así llegó el pedido');
  // El worker la descarga y la guarda; la bandeja la muestra con URL firmada.
  const photo = thread.getByTestId('imagen-adjunta');
  await expect(photo).toBeVisible();
  // Y la imagen CARGA de verdad desde el almacenamiento.
  await expect
    .poll(() => photo.evaluate((img: HTMLImageElement) => img.naturalWidth > 0))
    .toBe(true);

  // --- El agente adjunta un documento --------------------------------------------
  await page.getByRole('button', { name: 'Tomar' }).click();
  await page.getByTestId('selector-de-archivo').setInputFiles({
    name: 'Cotización.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.concat([Buffer.from('%PDF-1.7\n'), randomBytes(512)]),
  });
  await expect(page.getByTestId('adjunto-pendiente')).toContainText('Cotización.pdf');
  await page.getByLabel('Mensaje', { exact: true }).fill('Te paso la cotización');
  await page.getByRole('button', { name: 'Enviar' }).click();

  const document = thread.getByTestId('documento-adjunto');
  await expect(document).toContainText('Cotización.pdf');
  await expect(
    thread.getByTestId('mensaje').filter({ hasText: 'Te paso la cotización' }),
  ).toHaveAttribute('data-status', 'SENT');
  expect(uploadsToMeta.length).toBe(1);

  // --- Un tipo que WhatsApp no admite se avisa antes de subir ---------------------
  await page.getByTestId('selector-de-archivo').setInputFiles({
    name: 'programa.exe',
    mimeType: 'application/x-msdownload',
    buffer: Buffer.from('MZ'),
  });
  await expect(page.getByText('tipo de archivo no admitido por WhatsApp')).toBeVisible();
  await expect(page.getByTestId('adjunto-pendiente')).toHaveCount(0);
});

test('en móvil, la lista y la conversación se turnan', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  const account = newAccount('bandeja-movil');
  await registerAndVerify(page, account);
  await login(page, account.email, account.password);
  await expect(page).toHaveURL(workspaceUrl);
  const slug = new URL(page.url()).pathname.split('/')[2]!;
  const channel = await connectNumber(page, slug, phoneNumberId(2));
  await clientWrites(channel, CLIENT, 'Hola desde el móvil');

  await page.goto(`/w/${slug}/bandeja`);
  const list = page.getByRole('region', { name: 'Conversaciones' });
  const item = page.getByTestId(`conversacion-+${CLIENT}`);
  await item.click();
  await expect(page.getByRole('log', { name: 'Mensajes' })).toContainText('Hola desde el móvil');
  await expect(list).toBeHidden();

  await page.getByRole('button', { name: 'Volver a la lista' }).click();
  await expect(list).toBeVisible();
  await expect(page).not.toHaveURL(/[?&]c=/);

  // Nada se sale de la pantalla.
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});
