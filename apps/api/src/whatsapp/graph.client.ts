import { Inject, Injectable } from '@nestjs/common';
import type { ApiEnv } from '@nexo/contracts';
import { API_ENV } from '../config/config.module';

/** Error que devolvió Meta, con su mensaje tal cual (suele ser útil al usuario). */
export class GraphError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: number,
  ) {
    super(message);
    this.name = 'GraphError';
  }
}

/** Plantilla tal como la devuelve la Graph API. */
export interface MetaTemplate {
  id: string;
  name: string;
  language: string;
  category?: string;
  status: string;
  components?: unknown;
  rejected_reason?: string;
}

export interface PhoneNumberInfo {
  id: string;
  displayPhoneNumber: string;
  verifiedName: string | null;
}

/**
 * Cliente mínimo de la Graph API de Meta.
 *
 * La base (`META_GRAPH_URL`) y la versión son configurables: en las pruebas
 * apuntan a un simulador local, así que el CI no depende de Meta ni de un
 * número real.
 */
@Injectable()
export class GraphClient {
  constructor(@Inject(API_ENV) private readonly env: ApiEnv) {}

  private url(path: string): string {
    return `${this.env.META_GRAPH_URL.replace(/\/$/, '')}/${this.env.META_GRAPH_VERSION}/${path}`;
  }

  /** Comprueba que el token da acceso al número y devuelve sus datos. */
  async getPhoneNumber(phoneNumberId: string, accessToken: string): Promise<PhoneNumberInfo> {
    const body = await this.request<{
      id: string;
      display_phone_number: string;
      verified_name?: string;
    }>(`${phoneNumberId}?fields=id,display_phone_number,verified_name`, accessToken);
    return {
      id: body.id,
      displayPhoneNumber: body.display_phone_number,
      verifiedName: body.verified_name ?? null,
    };
  }

  /**
   * Plantillas de una cuenta de WhatsApp Business. Se piden todas de una vez
   * (100 por página, el máximo de Meta): una empresa con más de 100 plantillas
   * activas es rarísima, y paginar aquí añadiría estado sin necesidad.
   */
  async listTemplates(wabaId: string, accessToken: string): Promise<MetaTemplate[]> {
    const body = await this.request<{ data?: MetaTemplate[] }>(
      `${wabaId}/message_templates?fields=id,name,language,category,status,components,rejected_reason&limit=100`,
      accessToken,
    );
    return body.data ?? [];
  }

  private async request<T>(path: string, accessToken: string): Promise<T> {
    let response: Response;
    try {
      response = await fetch(this.url(path), {
        headers: { Authorization: `Bearer ${accessToken}` },
        // Meta a veces tarda; nunca tanto como para colgar la petición del usuario.
        signal: AbortSignal.timeout(10_000),
      });
    } catch (cause) {
      throw new GraphError(`No se pudo contactar con Meta: ${(cause as Error).message}`, 502);
    }

    const payload = (await response.json().catch(() => ({}))) as {
      error?: { message?: string; code?: number };
    };
    if (!response.ok) {
      throw new GraphError(
        payload.error?.message ?? `Meta respondió ${response.status}`,
        response.status,
        payload.error?.code,
      );
    }
    return payload as T;
  }
}
