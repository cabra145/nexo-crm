import { Inject, Injectable, Logger } from '@nestjs/common';
import { type ApiEnv, type EmailJob, emailJobSchema } from '@nexo/contracts';
import { Queue } from 'bullmq';
import { API_ENV } from '../config/config.module';
import type { RenderedMail } from './mail-templates';
import { EMAIL_QUEUE } from './queue-tokens';

/**
 * Encola correos. Los envía el worker, con reintentos si el SMTP falla.
 *
 * Los correos de autenticación NO deben hacer fallar la petición si no se
 * pueden encolar: la respuesta al usuario tiene que ser la misma exista o no
 * la cuenta (defensa contra enumeración), y un error distinto sólo en un caso
 * revelaría cuál es. El fallo queda en el log con nivel de error.
 */
@Injectable()
export class MailService {
  private readonly logger = new Logger('Correo');

  constructor(
    @Inject(EMAIL_QUEUE) private readonly queue: Queue,
    @Inject(API_ENV) private readonly env: ApiEnv,
  ) {}

  /** URL absoluta de la web. */
  webUrl(path: string, params?: Record<string, string>): string {
    const url = new URL(path, this.env.APP_URL);
    for (const [key, value] of Object.entries(params ?? {})) url.searchParams.set(key, value);
    return url.toString();
  }

  async send(
    to: string,
    mail: RenderedMail,
    meta: Pick<EmailJob, 'category'> & Partial<Pick<EmailJob, 'tenantId' | 'traceId'>>,
  ): Promise<void> {
    const job = emailJobSchema.parse({ to, ...mail, ...meta });
    try {
      await this.queue.add(meta.category, job);
    } catch (error) {
      this.logger.error(
        `No se pudo encolar el correo "${mail.subject}": ${(error as Error).message}`,
      );
    }
  }
}
