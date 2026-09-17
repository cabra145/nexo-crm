import type { SessionResponse } from '@nexo/contracts';
import { create } from 'zustand';

export type SessionStatus = 'unknown' | 'authenticated' | 'anonymous';

interface SessionState {
  status: SessionStatus;
  session: SessionResponse | null;
  /**
   * Token de acceso. Vive SÓLO en memoria: no en localStorage, no en una
   * cookie legible. Un XSS no tiene de dónde leerlo, y al cerrar la pestaña
   * desaparece. La continuidad entre recargas la da la cookie httpOnly de
   * refresco, que JavaScript no puede tocar.
   */
  accessToken: string | null;
  /** Instante (ms) en que caduca el token de acceso. */
  expiresAt: number;
  setSession: (session: SessionResponse) => void;
  setAnonymous: () => void;
}

/**
 * Estado de la sesión en el cliente.
 *
 * Es el único dato que vive en Zustand y no en React Query: no es una
 * respuesta cacheable del servidor sino la credencial con la que se piden
 * todas las demás.
 */
export const useSessionStore = create<SessionState>()((set) => ({
  status: 'unknown',
  session: null,
  accessToken: null,
  expiresAt: 0,
  setSession: (session) =>
    set({
      status: 'authenticated',
      session,
      accessToken: session.accessToken,
      expiresAt: Date.now() + session.expiresIn * 1000,
    }),
  setAnonymous: () => set({ status: 'anonymous', session: null, accessToken: null, expiresAt: 0 }),
}));
