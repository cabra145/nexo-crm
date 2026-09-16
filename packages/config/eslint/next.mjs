// @ts-check
import nextPlugin from '@next/eslint-plugin-next';
import { defineConfig } from 'eslint/config';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import { baseConfig, scriptsOverride } from './base.mjs';

/** App web: React 19 + Next.js 15. */
export function nextConfig({ tsconfigRootDir }) {
  return defineConfig(
    baseConfig({ tsconfigRootDir }),
    {
      files: ['**/*.{ts,tsx}'],
      plugins: {
        '@next/next': nextPlugin,
        'react-hooks': reactHooks,
      },
      languageOptions: {
        globals: { ...globals.browser },
      },
      rules: {
        ...nextPlugin.configs.recommended.rules,
        ...nextPlugin.configs['core-web-vitals'].rules,
        ...reactHooks.configs.recommended.rules,

        /* --- Seguridad: XSS ------------------------------------------------- */
        'no-restricted-syntax': [
          'error',
          {
            selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']",
            message:
              'dangerouslySetInnerHTML inyecta HTML sin escapar: es la vía más directa a un XSS. ' +
              'Si de verdad hace falta HTML de terceros, se sanea en el servidor con DOMPurify y se revisa.',
          },
        ],

        'no-console': ['error', { allow: ['error', 'warn'] }],
        '@typescript-eslint/consistent-type-imports': [
          'error',
          { fixStyle: 'inline-type-imports' },
        ],
      },
    },
    scriptsOverride,
  );
}
