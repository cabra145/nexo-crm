/**
 * La marca vive en @nexo/contracts, porque también la usa la API (nombre en el
 * autenticador de 2FA, remitente y pie de los correos) y ese paquete es el que
 * está compilado para Node. Aquí sólo se reexporta, para que la web siga
 * importándola desde el sistema de diseño.
 */
export { BRAND, copyrightLine, type Brand } from '@nexo/contracts/brand';
