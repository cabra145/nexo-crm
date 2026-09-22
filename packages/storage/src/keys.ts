import { randomUUID } from 'node:crypto';

/**
 * Claves de objeto con la empresa como prefijo:
 *
 *   tenants/{empresa}/{propósito}/{año}/{mes}/{uuid}.{ext}
 *
 *  · El prefijo por empresa permite borrar, exportar o medir todo lo de una
 *    empresa con una sola lista, y aplicar reglas de ciclo de vida por ruta.
 *  · El nombre original NUNCA forma parte de la clave: no se puede adivinar
 *    una clave ajena, ni colar «../» o caracteres raros en el bucket.
 *  · Año y mes reparten las claves y facilitan reglas de retención.
 */

export const STORAGE_PURPOSES = ['whatsapp-media', 'attachment', 'document', 'avatar'] as const;
export type StoragePurpose = (typeof STORAGE_PURPOSES)[number];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const tenantPrefix = (tenantId: string): string => {
  if (!UUID.test(tenantId)) throw new Error('Identificador de empresa inválido');
  return `tenants/${tenantId.toLowerCase()}/`;
};

export function tenantKey(
  tenantId: string,
  purpose: StoragePurpose,
  extension: string,
  now = new Date(),
): string {
  const ext = extension.replace(/^\./, '').toLowerCase();
  if (!/^[a-z0-9]{1,8}$/.test(ext)) throw new Error(`Extensión inválida: ${extension}`);
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `${tenantPrefix(tenantId)}${purpose}/${now.getUTCFullYear()}/${month}/${randomUUID()}.${ext}`;
}

/**
 * Última red: una clave que no es de esta empresa no se firma ni se lee,
 * aunque un error en otra capa la hubiera dejado llegar hasta aquí.
 */
export function assertTenantKey(tenantId: string, key: string): void {
  if (!key.startsWith(tenantPrefix(tenantId)) || key.includes('..') || key.includes('//')) {
    throw new Error('La clave no pertenece a esta empresa');
  }
}
