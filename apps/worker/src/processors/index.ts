import type { AnyProcessorDefinition } from '../lib/processor';
import { auditProcessor } from './audit.processor';
import { emailProcessor } from './email.processor';
import { whatsappInboundProcessor } from './whatsapp-inbound.processor';

/**
 * Procesadores activos. Añadir una cola nueva es escribir su procesador y
 * registrarlo aquí; el arranque, el cierre ordenado y la sonda de salud la
 * recogen solos.
 */
export const processors: AnyProcessorDefinition[] = [
  emailProcessor,
  auditProcessor,
  whatsappInboundProcessor,
];
