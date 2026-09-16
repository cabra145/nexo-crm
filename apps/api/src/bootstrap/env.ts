/**
 * Configuración validada de la API.
 *
 * Este módulo tiene que ser lo PRIMERO que importe `main.ts`: carga el `.env`
 * y lo valida antes de que se importe cualquier otra cosa. El orden importa de
 * verdad — `@nexo/database` crea el cliente de Prisma al importarse, y si
 * `DATABASE_URL` no está ya en el entorno, falla con un mensaje que no dice
 * nada útil.
 *
 * Si la configuración es inválida, `parseEnv` aborta el proceso indicando qué
 * variable falta o está mal y cómo generarla.
 */
import './load-env';
import { apiEnvSchema, parseEnv, type ApiEnv } from '@nexo/contracts';

export const env: ApiEnv = parseEnv(apiEnvSchema);
