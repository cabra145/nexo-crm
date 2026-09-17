/**
 * El token de la invitación mientras se inicia sesión para aceptarla.
 *
 * sessionStorage y no la URL: el token es una llave de un solo uso y en la
 * URL quedaría en el historial y en la cabecera Referer. Muere al cerrar la
 * pestaña.
 */
const KEY = 'nexo:invitacion:token';

export const invitationStorage = {
  get(): string | null {
    try {
      return sessionStorage.getItem(KEY);
    } catch {
      return null;
    }
  },
  set(token: string): void {
    try {
      sessionStorage.setItem(KEY, token);
    } catch {
      // Sin almacenamiento (modo privado estricto): se pierde el paso por el login.
    }
  },
  clear(): void {
    try {
      sessionStorage.removeItem(KEY);
    } catch {
      // Nada que limpiar.
    }
  },
};
