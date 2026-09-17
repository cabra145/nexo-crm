/**
 * Utilidades compartidas por las pruebas de extremo a extremo contra la API
 * real (auth:e2e, rbac:e2e): peticiones HTTP, correos de Mailpit, TOTP y el
 * recuento de comprobaciones.
 */
import { CLIENT_HEADER, CLIENT_HEADER_VALUE, REFRESH_COOKIE } from '@nexo/contracts';
import { base32Decode, currentStep, hotp } from '../../src/auth/totp';

export const API = process.env.API_URL ?? `http://127.0.0.1:${process.env.API_PORT ?? 4000}/api/v1`;
export const MAILPIT = process.env.MAILPIT_URL ?? 'http://127.0.0.1:8025';
export const APP_ORIGIN = new URL(process.env.APP_URL ?? 'http://localhost:3000').origin;

/* ========================================================================== */
/*  Utilidades                                                                 */
/* ========================================================================== */

export const results: Array<{ name: string; passed: boolean }> = [];
export function check(name: string, passed: boolean, detail = ''): void {
  results.push({ name, passed });
  console.log(`  ${passed ? '✓' : '✗'} ${name}${detail ? `  — ${detail}` : ''}`);
}
export const section = (title: string) => console.log(`\n${title}`);

export interface HttpResult<T = Record<string, unknown>> {
  status: number;
  body: T;
  headers: Headers;
  refreshCookie: string | null;
  setCookieRaw: string[];
}

export async function http<T = Record<string, unknown>>(
  method: string,
  path: string,
  opts: {
    body?: unknown;
    token?: string;
    cookie?: string | null;
    client?: boolean;
    origin?: string;
    userAgent?: string;
  } = {},
): Promise<HttpResult<T>> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  if (opts.cookie) headers.Cookie = `${REFRESH_COOKIE}=${opts.cookie}`;
  if (opts.client) headers[CLIENT_HEADER] = CLIENT_HEADER_VALUE;
  if (opts.origin) headers.Origin = opts.origin;
  if (opts.userAgent) headers['User-Agent'] = opts.userAgent;

  const res = await fetch(`${API}${path}`, {
    method,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  const setCookieRaw = res.headers.getSetCookie();
  const match = setCookieRaw
    .map((c) => new RegExp(`^${REFRESH_COOKIE}=([^;]*)`).exec(c))
    .find(Boolean);
  return {
    status: res.status,
    body: (text ? JSON.parse(text) : {}) as T,
    headers: res.headers,
    refreshCookie: match ? match[1] || null : null,
    setCookieRaw,
  };
}

interface MailpitMessage {
  ID: string;
  Subject: string;
  To: Array<{ Address: string }>;
  Created: string;
}

/** Espera un correo para `to` cuyo asunto contenga `subject`, más nuevo que `after`. */
export async function waitForMail(
  to: string,
  subject: string,
  after: number,
  timeoutMs = 15_000,
): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await fetch(`${MAILPIT}/api/v1/messages?limit=100`);
    const body = (await res.json()) as { messages?: MailpitMessage[] };
    const found = body.messages?.find(
      (m) =>
        m.To.some((t) => t.Address === to) &&
        m.Subject.includes(subject) &&
        new Date(m.Created).getTime() >= after - 2_000,
    );
    if (found) {
      const detail = (await (await fetch(`${MAILPIT}/api/v1/message/${found.ID}`)).json()) as {
        Text: string;
      };
      return detail.Text;
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  return null;
}

export const tokenFrom = (text: string | null) =>
  text ? (/token=([A-Za-z0-9_-]+)/.exec(text)?.[1] ?? null) : null;

export function totpFor(secret: string, stepOffset = 0): string {
  return hotp(base32Decode(secret), currentStep() + stepOffset);
}

/** Imprime el resumen y fija el código de salida. */
export function summarize(successMessage: string): void {
  const failed = results.filter((r) => !r.passed).length;
  console.log(`\n${results.length - failed}/${results.length} comprobaciones superadas`);
  if (failed) process.exitCode = 1;
  else console.log(`${successMessage}\n`);
}
