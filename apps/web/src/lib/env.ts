import { z } from 'zod';

/**
 * Configuración pública de la web.
 *
 * Sólo variables NEXT_PUBLIC_*: son las únicas que llegan al navegador, y se
 * incrustan en el código al compilar. Por eso cada una se referencia con su
 * nombre literal (`process.env.NEXT_PUBLIC_API_URL`): Next no puede sustituir
 * un acceso dinámico como `process.env[nombre]`.
 *
 * Un secreto NUNCA va aquí. Todo lo que empiece por NEXT_PUBLIC_ lo puede leer
 * cualquiera que abra la web.
 */
const schema = z.object({
  NEXT_PUBLIC_API_URL: z
    .string({ required_error: 'falta NEXT_PUBLIC_API_URL en el .env de la raíz' })
    .url('NEXT_PUBLIC_API_URL debe ser una URL, p. ej. http://localhost:4000/api/v1')
    .transform((url) => url.replace(/\/+$/, '')),
});

const parsed = schema.safeParse({
  NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL,
});

if (!parsed.success) {
  throw new Error(
    `Configuración de la web inválida:\n${parsed.error.issues.map((i) => `  · ${i.message}`).join('\n')}`,
  );
}

export const publicEnv = parsed.data;
