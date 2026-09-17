// @ts-check
import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/**
 * Configuración base de ESLint para todo el monorepo.
 *
 * Tres criterios, por orden de importancia:
 *
 *  1. SEGURIDAD. Las reglas que el documento de arquitectura prometía que
 *     vivirían en el linter y no en la memoria de quien revisa: nada de SQL
 *     crudo sin parametrizar, nada de HTML inyectado.
 *  2. CORRECCIÓN. Reglas con información de tipos. La más valiosa aquí es
 *     `no-floating-promises`: las consultas de Prisma son promesas perezosas,
 *     y una sin `await` no se ejecuta nunca — el error del paso 19 de la
 *     validación era de esa familia.
 *  3. Nada de estilo. El formato es cosa de Prettier; el linter no opina sobre
 *     comas ni espacios.
 */
export function baseConfig({ tsconfigRootDir }) {
  return defineConfig(
    {
      ignores: [
        '**/dist/**',
        '**/.next/**',
        '**/.next-ci/**',
        '**/playwright-report/**',
        '**/test-results/**',
        '**/.turbo/**',
        '**/coverage/**',
        '**/node_modules/**',
        '**/next-env.d.ts',
      ],
    },

    js.configs.recommended,
    tseslint.configs.recommendedTypeChecked,

    {
      languageOptions: {
        parserOptions: {
          // Cada archivo usa el tsconfig.json más cercano: el mismo que usa
          // `tsc`, así que linter y compilador ven exactamente los mismos tipos.
          projectService: true,
          tsconfigRootDir,
        },
      },
      linterOptions: {
        reportUnusedDisableDirectives: 'error',
      },
      rules: {
        /* --- Seguridad ----------------------------------------------------- */
        'no-restricted-properties': [
          'error',
          {
            property: '$queryRawUnsafe',
            message:
              'SQL crudo sin parametrizar = inyección SQL. Usa $queryRaw con plantilla etiquetada: ' +
              'prisma.$queryRaw`... ${valor}` parametriza cada valor.',
          },
          {
            property: '$executeRawUnsafe',
            message:
              'SQL crudo sin parametrizar = inyección SQL. Usa $executeRaw con plantilla etiquetada.',
          },
        ],
        'no-eval': 'error',
        'no-implied-eval': 'off',
        '@typescript-eslint/no-implied-eval': 'error',
        'no-new-func': 'error',

        /* --- Corrección ---------------------------------------------------- */
        '@typescript-eslint/no-floating-promises': ['error', { ignoreVoid: true }],
        '@typescript-eslint/no-misused-promises': [
          'error',
          // onClick={async () => …} es un patrón legítimo en React.
          { checksVoidReturn: { attributes: false } },
        ],
        '@typescript-eslint/switch-exhaustiveness-check': 'error',
        eqeqeq: ['error', 'smart'],
        'no-param-reassign': ['error', { props: false }],
        '@typescript-eslint/no-unused-vars': [
          'error',
          { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
        ],

        /* --- Tipos --------------------------------------------------------- */
        // `any` se permite sólo donde se justifica con un comentario en línea
        // (límites con librerías sin tipos precisos, como las extensiones de
        // Prisma). Así cada `any` deja constancia de por qué existe.
        '@typescript-eslint/no-explicit-any': 'error',
      },
    },

    /* --- JavaScript sin tipos (configs, scripts .mjs) ------------------------ */
    {
      files: ['**/*.{js,mjs,cjs}'],
      extends: [tseslint.configs.disableTypeChecked],
      languageOptions: { globals: globals.node },
    },
  );
}

/**
 * Scripts de terminal —seed, pruebas, generadores— escriben en consola a
 * propósito: es su interfaz. Se exporta aparte porque tiene que aplicarse
 * DESPUÉS de las reglas de cada entorno; si fuera dentro de la base, el
 * `no-console` de node.mjs o next.mjs la anularía.
 */
export const scriptsOverride = {
  files: ['**/scripts/**', '**/prisma/seed.ts'],
  rules: { 'no-console': 'off' },
};
