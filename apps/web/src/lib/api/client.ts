import type { ApiProblem } from '@nexo/contracts';
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
}

/**
 * Cliente HTTP de la API.
 *
 * Envía las cookies (`credentials: 'include'`), porque la sesión de la Fase 1
 * viaja en una cookie httpOnly que JavaScript no puede leer, y convierte toda
 * respuesta de error en un `ApiError` con su problema RFC 7807.
 */
export async function apiFetch<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { body, acceptStatus = [], headers, ...init } = options;
  const url = `${publicEnv.NEXT_PUBLIC_API_URL}${path.startsWith('/') ? path : `/${path}`}`;

  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      credentials: 'include',
      headers: {
        Accept: 'application/json',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (cause) {
    throw new ApiUnreachableError(publicEnv.NEXT_PUBLIC_API_URL, cause);
  }

  const isJson = response.headers.get('content-type')?.includes('json') ?? false;
  const payload: unknown = isJson ? await response.json().catch(() => null) : null;

  if (response.ok || acceptStatus.includes(response.status)) {
    return payload as T;
  }

  const problem: ApiProblem =
    payload && typeof payload === 'object' && 'status' in payload
      ? (payload as ApiProblem)
      : {
          type: 'about:blank',
          title: 'Error inesperado',
          status: response.status,
          detail: `La API respondió ${response.status} sin un problema legible.`,
        };

  // Si el cuerpo no trae traceId, se toma de la cabecera: siempre está.
  problem.traceId ??= response.headers.get('x-trace-id') ?? undefined;

  throw new ApiError(problem);
}
