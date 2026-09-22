import { cleanupUploadJobSchema, QUEUE_NAMES } from '@nexo/contracts';
import { runInTenantTransaction } from '@nexo/database';
import { env } from '../bootstrap/env';
import { defineProcessor } from '../lib/processor';
import { storage } from '../lib/storage';

/**
 * Borra una subida que se reservó y nunca se envió.
 *
 * La API encola este trabajo APLAZADO al reservar (id del trabajo = el del
 * archivo, así que nunca hay dos). Cuando salta, comprueba que el archivo
 * sigue siendo una reserva abandonada y lo borra: primero el objeto, después
 * la fila. Al revés quedaría un objeto del que ya nadie sabría nada.
 *
 * No es un barrido de todas las empresas: el rol de la aplicación no puede
 * saltarse la RLS, y eso es deliberado. Este trabajo corre en el contexto de
 * SU empresa, con las mismas reglas que cualquier otra consulta.
 *
 * Nunca toca:
 *   · un archivo ya enviado (READY): es contenido de un cliente;
 *   · uno enlazado a un mensaje;
 *   · uno más nuevo que el plazo (una reserva que alguien está usando ahora).
 */
export const storageCleanupProcessor = defineProcessor({
  queue: QUEUE_NAMES.MAINTENANCE,
  schema: cleanupUploadJobSchema,
  tenantOf: (data) => data.tenantId,

  async handle(data, { log }) {
    if (!storage) return { skipped: 'almacenamiento desactivado' };
    const olderThan = new Date(Date.now() - env.STORAGE_PENDING_TTL_HOURS * 3600_000);

    const file = await runInTenantTransaction((tx) =>
      tx.file.findFirst({
        where: {
          id: data.fileId,
          status: 'PENDING',
          createdAt: { lt: olderThan },
          media: { none: {} },
        },
        select: { id: true, storageKey: true, bucket: true },
      }),
    );
    if (!file) return { skipped: 'no es una reserva abandonada' };
    if (file.bucket !== storage.bucket) {
      log.warn({ fileId: file.id, bucket: file.bucket }, 'Reserva de otro bucket: no se toca');
      return { skipped: 'otro bucket' };
    }

    await storage.delete([file.storageKey]);
    const removed = await runInTenantTransaction((tx) =>
      tx.file.deleteMany({
        // Con las mismas condiciones: si entretanto se envió o se enlazó, la
        // fila se queda (y el objeto ya no estaría, pero para llegar aquí
        // tendría que haberse enviado en este preciso instante).
        where: { id: file.id, status: 'PENDING', media: { none: {} } },
      }),
    );
    log.info({ fileId: file.id, deleted: removed.count }, 'Subida abandonada borrada');
    return { deleted: removed.count };
  },
});
