// Primero, antes que nada: carga y valida el entorno. Ver bootstrap/env.ts.
import { env } from './bootstrap/env';

import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    // Retiene los logs del arranque hasta que el logger estructurado esté
    // listo, para que no salgan unos en un formato y otros en otro.
    bufferLogs: true,
  });

  const logger = app.get(Logger);
  app.useLogger(logger);

  // Detrás de Nginx: sin esto, la IP de todas las peticiones sería la del
  // proxy y el límite de tasa por IP bloquearía a todos los usuarios a la vez.
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(
    helmet({
      // La API sirve JSON, no HTML: la CSP que importa es la de la web, que la
      // define Next.js. Aquí sólo estorbaría a la interfaz de /api/docs.
      contentSecurityPolicy: false,
      crossOriginResourcePolicy: { policy: 'same-site' },
    }),
  );

  // Necesario para leer la cookie httpOnly del token de refresco (Fase 1).
  app.use(cookieParser());

  app.enableCors({
    origin: env.APP_URL,
    // Las cookies de sesión viajan con las peticiones de la web.
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key', 'X-Request-Id'],
    exposedHeaders: ['X-Trace-Id', 'RateLimit-Limit', 'RateLimit-Remaining', 'RateLimit-Reset'],
    maxAge: 600,
  });

  app.setGlobalPrefix('api/v1');
  app.enableShutdownHooks();

  // --- Documentación OpenAPI -------------------------------------------------
  const openapi = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle('Nexo CRM API')
      .setDescription(
        'API REST de Nexo CRM. Toda petición autenticada opera sobre la empresa ' +
          'del token; la empresa nunca va en la URL. Los errores siguen RFC 7807.',
      )
      .setVersion('1.0')
      .addBearerAuth()
      .build(),
  );
  SwaggerModule.setup('api/docs', app, openapi, {
    jsonDocumentUrl: 'api/docs/openapi.json',
    customSiteTitle: 'Nexo CRM · API',
  });

  await app.listen(env.API_PORT, '0.0.0.0');

  logger.log(`API lista en http://localhost:${env.API_PORT}/api/v1`, 'Arranque');
  logger.log(`Documentación en http://localhost:${env.API_PORT}/api/docs`, 'Arranque');
}

bootstrap().catch((error: unknown) => {
  // El logger estructurado puede no existir todavía si falló el propio
  // arranque de Nest, así que aquí se escribe directamente.
  console.error('\nLa API no pudo arrancar:\n');
  console.error(error);
  process.exit(1);
});
