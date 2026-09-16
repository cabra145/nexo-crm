/**
 * Configuración validada del worker. Tiene que ser lo PRIMERO que importe
 * `main.ts`: `@nexo/database` crea el cliente de Prisma al importarse y
 * necesita `DATABASE_URL` ya en el entorno.
 */
import './load-env';
import { parseEnv, workerEnvSchema, type WorkerEnv } from '@nexo/contracts';

export const env: WorkerEnv = parseEnv(workerEnvSchema);
