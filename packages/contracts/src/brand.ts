/**
 * Identidad del producto, en un solo sitio.
 *
 * Todo lo que muestra el nombre —la pestaña del navegador, el pie de los
 * correos, la cabecera de los PDFs, el remitente, el nombre en el autenticador
 * de 2FA— lo lee de aquí. Cambiar la
 * marca es editar este archivo, no buscar cadenas por todo el repositorio.
 *
 * Esto NO es la identidad visual de las empresas cliente: cada una tiene su
 * logo y su color en `tenant.logoUrl` y `tenant.brandColor`, y son los que
 * aparecen en sus documentos. Lo de aquí es la marca de la plataforma.
 */
export const BRAND = {
  /** Nombre corto. Aparece en la interfaz. */
  name: 'Nexo',

  /** Nombre completo. Portada, correos, documentos legales. */
  fullName: 'Nexo CRM',

  /** Una frase. Página de inicio y metadatos de enlace compartido. */
  tagline: 'El CRM donde vive tu equipo comercial',

  /** Descripción para buscadores y vistas previas. */
  description:
    'CRM multiempresa con WhatsApp, automatizaciones e inteligencia artificial. ' +
    'Cada empresa, su propio espacio de trabajo.',

  /** Dominio de producción. Sin protocolo. */
  domain: 'nexo.app',

  email: {
    /** Remitente de los correos transaccionales. */
    from: 'no-responder@nexo.app',
    /** A dónde escribe el usuario si responde. */
    replyTo: 'hola@nexo.app',
    support: 'soporte@nexo.app',
  },

  legal: {
    company: 'Nexo Software',
    /** Año de inicio, para el "© 2026–{año actual}" del pie. */
    since: 2026,
  },

  urls: {
    marketing: 'https://nexo.app',
    docs: 'https://docs.nexo.app',
    status: 'https://status.nexo.app',
    terms: 'https://nexo.app/terminos',
    privacy: 'https://nexo.app/privacidad',
  },
} as const;

export type Brand = typeof BRAND;

/** "© 2026–2028 Nexo Software" — el rango se calcula solo. */
export function copyrightLine(now: Date = new Date()): string {
  const year = now.getFullYear();
  const range = year > BRAND.legal.since ? `${BRAND.legal.since}–${year}` : `${BRAND.legal.since}`;
  return `© ${range} ${BRAND.legal.company}`;
}
