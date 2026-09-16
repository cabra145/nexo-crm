import { Global, Module } from '@nestjs/common';
import { env } from '../bootstrap/env';

/**
 * Token de inyección de la configuración validada.
 *
 * Se inyecta con `@Inject(API_ENV) env: ApiEnv` en vez de leer `process.env`
 * directamente: así toda la API usa los valores ya validados y tipados, y en
 * las pruebas se puede sustituir la configuración entera sin tocar el entorno.
 */
export const API_ENV = Symbol('API_ENV');

@Global()
@Module({
  providers: [{ provide: API_ENV, useValue: env }],
  exports: [API_ENV],
})
export class ConfigModule {}
