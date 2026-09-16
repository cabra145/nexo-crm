// @ts-check
import { defineConfig } from 'eslint/config';
import globals from 'globals';
import { baseConfig, scriptsOverride } from './base.mjs';

/**
 * Procesos de servidor: API, worker y paquetes de datos.
 *
 * `emitDecoratorMetadata`: NestJS resuelve la inyección de dependencias leyendo
 * el tipo de cada parámetro del constructor EN EJECUCIÓN. Si una regla
 * convirtiera `import { DatabaseService }` en `import type`, ese tipo
 * desaparecería del JavaScript compilado y la inyección fallaría al arrancar.
 * Con esta opción, typescript-eslint sabe que esos imports son valores.
 */
export function nodeConfig({ tsconfigRootDir, decorators = false }) {
  return defineConfig(
    baseConfig({ tsconfigRootDir }),
    {
      languageOptions: {
        globals: globals.node,
        parserOptions: decorators
          ? { emitDecoratorMetadata: true, experimentalDecorators: true }
          : {},
      },
      rules: {
        // En servidor, todo va al logger estructurado; console.* no llega al
        // agregador con traceId ni con nivel.
        'no-console': ['error', { allow: ['error'] }],
        '@typescript-eslint/consistent-type-imports': decorators
          ? 'off'
          : ['error', { fixStyle: 'inline-type-imports' }],
      },
    },
    scriptsOverride,
  );
}
