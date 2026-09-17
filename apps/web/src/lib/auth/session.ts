'use client';

import type { SessionResponse } from '@nexo/contracts';
import { ApiError, apiFetch, setSessionRefresher } from '@/lib/api/client';
import { useSessionStore } from './session-store';

/**
 * Ciclo de vida de la sesión en el navegador.
 *
 * El problema que resuelve este archivo: la cookie de refresco ROTA en cada
 * uso, y la API revoca la sesión entera si ve la misma cookie dos veces
 * (detección de robo). Con varias pestañas abiertas, si dos renovaran a la
 * vez con la misma cookie, la segunda parecería un robo y cerraría la sesión
 * de todas.
 *
 * Dos mecanismos lo impiden:
 *
 *  1. Web Locks: sólo una pestaña renueva a la vez. La siguiente espera, y
 *     cuando entra ya tiene la cookie nueva (el almacén de cookies del
 *     navegador es compartido por todas las pestañas).
 *  2. BroadcastChannel: la pestaña que renueva comparte la sesión nueva con
 *     las demás. La que esperaba el turno ve que ya hay un token fresco y no
 *     renueva otra vez.
 */

const LOCK = 'nexo:session-refresh';
const CHANNEL = 'nexo:session';
/** Se renueva con este margen antes de que caduque el token. */
const REFRESH_MARGIN_MS = 60_000;

type Message = { type: 'session'; session: SessionResponse } | { type: 'logout' };

let channel: BroadcastChannel | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;

function getChannel(): BroadcastChannel | null {
  if (typeof window === 'undefined' || typeof BroadcastChannel === 'undefined') return null;
  if (!channel) {
    channel = new BroadcastChannel(CHANNEL);
    channel.onmessage = (event: MessageEvent<Message>) => {
      if (event.data.type === 'session') applySession(event.data.session, { broadcast: false });
      if (event.data.type === 'logout') endSession({ broadcast: false });
    };
  }
  return channel;
}

function schedule(expiresInSeconds: number): void {
  if (timer) clearTimeout(timer);
  const delay = Math.max(expiresInSeconds * 1000 - REFRESH_MARGIN_MS, 5_000);
  timer = setTimeout(() => void refreshSession(), delay);
}

export function applySession(session: SessionResponse, { broadcast = true } = {}): void {
  useSessionStore.getState().setSession(session);
  schedule(session.expiresIn);
  if (broadcast) getChannel()?.postMessage({ type: 'session', session } satisfies Message);
}

export function endSession({ broadcast = true } = {}): void {
  if (timer) clearTimeout(timer);
  timer = null;
  useSessionStore.getState().setAnonymous();
  if (broadcast) getChannel()?.postMessage({ type: 'logout' } satisfies Message);
}

async function withLock<T>(fn: () => Promise<T>): Promise<T> {
  if (typeof navigator !== 'undefined' && navigator.locks) {
    return navigator.locks.request(LOCK, fn);
  }
  // Navegadores sin Web Locks (muy antiguos): sin coordinación entre pestañas.
  return fn();
}

let inFlight: Promise<SessionResponse | null> | null = null;

/**
 * Renueva la sesión con la cookie de refresco. Devuelve la sesión, o null si
 * no hay sesión válida (el usuario tiene que iniciar sesión).
 *
 * Dentro de la misma pestaña, llamadas simultáneas comparten una sola petición.
 */
export function refreshSession({ force = false } = {}): Promise<SessionResponse | null> {
  getChannel();
  inFlight ??= withLock(async () => {
    const { accessToken, expiresAt, session } = useSessionStore.getState();
    // Otra pestaña renovó mientras esperábamos el turno. `force` lo salta:
    // se usa cuando el token sigue vigente pero su contenido cambió (p. ej.
    // tras desactivar el 2FA, que vuelve a exigirlo).
    if (!force && accessToken && session && expiresAt - Date.now() > REFRESH_MARGIN_MS)
      return session;

    try {
      const fresh = await apiFetch<SessionResponse>('/auth/refresh', {
        method: 'POST',
        sessionCookie: true,
      });
      applySession(fresh);
      return fresh;
    } catch (error) {
      if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
        endSession();
        return null;
      }
      throw error;
    }
  }).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

export async function logout(): Promise<void> {
  try {
    await apiFetch('/auth/logout', { method: 'POST', sessionCookie: true });
  } finally {
    endSession();
  }
}

// El cliente de la API renueva la sesión solo cuando recibe un 401.
setSessionRefresher(async ({ force }) => (await refreshSession({ force }))?.accessToken ?? null);
