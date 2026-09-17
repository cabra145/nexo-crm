import {
  AUTH_PROBLEMS,
  CLIENT_HEADER,
  CLIENT_HEADER_VALUE,
  TEAM_PROBLEMS,
  type ApiProblem,
} from '@nexo/contracts';
import { useSessionStore } from '@/lib/auth/session-store';
import { publicEnv } from '@/lib/env';

/**
 * Error de la API con el problema RFC 7807 que devolvió.
 *
 * Lleva el `traceId`: la interfaz lo muestra para que el usuario se lo pueda
 * dar a soporte, y soporte encuentra con él la petición exacta en los logs.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly problem: ApiProblem;

  constructor(problem: ApiProblem) {
    super(problem.detail ?? problem.title);
    this.name = 'ApiError';
    this.status = problem.status;
    this.problem = problem;
  }

  get traceId(): string | undefined {
    return this.problem.traceId;
  }

  /** Error de validación de un campo concreto, para pintarlo junto a su input. */
  fieldError(field: string): string | undefined {
    return this.problem.errors?.find((e) => e.field === field)?.message;
  }
}

/** La API no respondió: caída, sin red, CORS o URL mal configurada. */
export class ApiUnreachableError extends Error {
  constructor(
    readonly url: string,
    cause: unknown,
  ) {
    super(`No se pudo conectar con la API en ${url}`, { cause });
    this.name = 'ApiUnreachableError';
  }
}

export interface RequestOptions extends Omit<RequestInit, 'body'> {
  body?: unknown;
  /**
   * Códigos de estado que NO se tratan como error y cuyo cuerpo se devuelve
   * tal cual. Ejemplo: /health/ready responde 503 con el detalle de qué
   * dependencia falla, y ese detalle es justo lo que hay que mostrar.
   */
  acceptStatus?: number[];
  /**
   * Envía el token de acceso de la sesión. Si la API responde que caducó, se
   * renueva la sesión UNA vez y se repite la petición.
   */
  auth?: boolean;
  /**
   * La ruta actúa con la cookie de refresco (renovar, cerrar sesión, cambiar
   * de empresa): se envía la cabecera que la API exige contra CSRF.
   */
  sessionCookie?: boolean;
}

type Refresher = (options: { force: boolean }) => Promise<string | null>;
let refresher: Refresher | null = null;

/** Lo registra lib/auth/session.ts. Evita una importación circular. */
export function setSessionRefresher(fn: Refresher): void {
  refresher = fn;
}

async function send(
  path: string,
  options: RequestOptions,
  token: string | null,
): Promise<Response> {
  const { body, acceptStatus: _accept, auth: _auth, sessionCookie, headers, ...init } = options;
  const url = `${publicEnv.NEXT_PUBLIC_API_URL}${path.startsWith('/') ? path : `/${path}`}`;
  try {
    return await fetch(url, {
      ...init,
      // Imprescindible para que el navegador envíe y guarde la cookie de
      // refresco, que la API pone en su propio origen.
      credentials: 'include',
      headers: {
        Accept: 'application/json',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(sessionCookie ? { [CLIENT_HEADER]: CLIENT_HEADER_VALUE } : {}),
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (cause) {
    throw new ApiUnreachableError(publicEnv.NEXT_PUBLIC_API_URL, cause);
  }
}

async function problemFrom(response: Response): Promise<ApiProblem> {
  const isJson = response.headers.get('content-type')?.includes('json') ?? false;
  const payload: unknown = isJson ? await response.json().catch(() => null) : null;
  const problem: ApiProblem =
    payload && typeof payload === 'object' && 'status' in payload
      ? (payload as ApiProblem)
      : {
          type: 'about:blank',
          title: 'Error inesperado',
          status: response.status,
          detail: `La API respondió ${response.status} sin un problema legible.`,
        };
  problem.traceId ??= response.headers.get('x-trace-id') ?? undefined;
  return problem;
}

/**
 * Cliente HTTP de la API.
 *
 * Convierte toda respuesta de error en un `ApiError` con su problema RFC 7807,
 * y gestiona la sesión: token en cabecera y renovación transparente.
 */
export async function apiFetch<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const token = options.auth ? useSessionStore.getState().accessToken : null;
  let response = await send(path, options, token);

  if (response.status === 401 && options.auth && refresher) {
    const problem = await problemFrom(response.clone());
    if (problem.type === AUTH_PROBLEMS.SESSION_EXPIRED) {
      const renewed = await refresher({ force: false });
      if (renewed) response = await send(path, options, renewed);
    } else if (problem.type === TEAM_PROBLEMS.MEMBERSHIP_INACTIVE) {
      // Ya no pertenece a la empresa del token. Se renueva la sesión (que
      // caerá en otra empresa suya, o en ninguna) pero la petición NO se
      // repite: con el token nuevo iría contra OTRA empresa. La puerta del
      // espacio de trabajo ve el cambio y lleva a donde corresponde.
      await refresher({ force: true }).catch(() => null);
    }
  }

  if (response.status === 204) return undefined as T;

  if (response.ok || options.acceptStatus?.includes(response.status)) {
    const isJson = response.headers.get('content-type')?.includes('json') ?? false;
    return (isJson ? await response.json() : undefined) as T;
  }

  throw new ApiError(await problemFrom(response));
}
