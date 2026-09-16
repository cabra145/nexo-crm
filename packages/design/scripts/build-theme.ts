/**
 * Genera `dist/theme.css` —la configuración de Tailwind 4— a partir de
 * `src/tokens.ts`.
 *
 * Tailwind 4 se configura en CSS (`@theme`), pero los tokens tienen que seguir
 * viviendo en TypeScript: los usan también los gráficos, los PDFs y el correo,
 * que no leen CSS. Escribir el CSS a mano los desincronizaría en la primera
 * semana. Así que el CSS no se edita: se genera.
 *
 *   pnpm --filter @nexo/design build     (Turbo lo lanza antes de la web)
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  categorical,
  critical,
  fonts,
  fontSize,
  info,
  motion,
  neutral,
  positive,
  primary,
  radius,
  semanticTokens,
  shadow,
  warning,
} from '../src/tokens';

const out: string[] = [];
const line = (s = '') => out.push(s);

/* -------------------------------------------------------------------------- */
line('/*');
line(' * GENERADO desde packages/design/src/tokens.ts — NO EDITAR A MANO.');
line(' * Para cambiar un token: edita tokens.ts y ejecuta `pnpm --filter @nexo/design build`.');
line(' */');
line();

// El tema oscuro lo marca next-themes con data-theme="dark" en <html>, que
// también refleja la preferencia del sistema cuando el usuario elige "Sistema".
line('@custom-variant dark (&:where([data-theme="dark"], [data-theme="dark"] *));');
line();

/* --- Valores fijos: no cambian con el tema --------------------------------- */
line('@theme {');

line('  /* Tipografía */');
line(`  --font-sans: ${fonts.sans};`);
line(`  --font-mono: ${fonts.mono};`);
for (const [name, [size, meta]] of Object.entries(fontSize)) {
  line(`  --text-${name}: ${size};`);
  if ('lineHeight' in meta) line(`  --text-${name}--line-height: ${meta.lineHeight};`);
  if ('letterSpacing' in meta) line(`  --text-${name}--letter-spacing: ${meta.letterSpacing};`);
}
line();

line('  /* Forma */');
for (const [name, value] of Object.entries(radius)) {
  if (name !== 'full') line(`  --radius-${name}: ${value};`);
}
line(`  --shadow-raised: ${shadow.raised};`);
line(`  --shadow-overlay: ${shadow.overlay};`);
line();

line('  /* Movimiento */');
line(`  --ease-smooth: ${motion.easing};`);
line();

line('  /* Medidas con nombre del producto: w-sidebar, w-kanban-column, max-w-form… */');
line('  --spacing-sidebar: 15rem;');
line('  --spacing-sidebar-collapsed: 3.5rem;');
line('  --spacing-inbox-list: 20rem;');
line('  --spacing-detail-panel: 22rem;');
line('  --spacing-kanban-column: 19rem;');
line('  --container-form: 34rem;');
line();

line('  /* Escalas */');
const scales = { neutral, primary, positive, warning, critical, info } as const;
for (const [scale, steps] of Object.entries(scales)) {
  for (const [step, value] of Object.entries(steps)) {
    line(`  --color-${scale}-${step}: ${value};`);
  }
}
categorical.forEach((value, i) => line(`  --color-chart-${i + 1}: ${value};`));
line();

line('  /* Animaciones */');
line(`  --animate-fade-in: fade-in ${motion.duration.normal}ms ${motion.easing};`);
line(`  --animate-slide-up: slide-up ${motion.duration.normal}ms ${motion.easing};`);
line(`  --animate-slide-in-right: slide-in-right ${motion.duration.slow}ms ${motion.easing};`);
line('  --animate-typing-dot: typing-dot 1.4s ease-in-out infinite;');
line('  @keyframes fade-in { from { opacity: 0; } to { opacity: 1; } }');
line('  @keyframes slide-up { from { transform: translateY(0.5rem); opacity: 0; } to { transform: translateY(0); opacity: 1; } }');
line('  @keyframes slide-in-right { from { transform: translateX(100%); } to { transform: translateX(0); } }');
line('  @keyframes typing-dot { 0%, 60%, 100% { opacity: 0.3; transform: translateY(0); } 30% { opacity: 1; transform: translateY(-0.125rem); } }');
line('}');
line();

/* --- Valores semánticos: cambian con el tema ------------------------------- */
// `@theme inline` hace que `bg-surface` compile a `var(--nx-surface)` en vez
// de a un valor fijo, así que cambiar de tema no requiere recompilar nada.
// El prefijo --nx- evita chocar con las variables --color-* de Tailwind.
line('@theme inline {');
for (const token of Object.keys(semanticTokens.light)) {
  line(`  --color-${token}: var(--nx-${token});`);
}
line();
// Alias con los nombres que usan los componentes de shadcn/ui. Así un
// `npx shadcn add <componente>` funciona sin retocar sus clases.
line('  /* Alias para shadcn/ui */');
const shadcn: Record<string, string> = {
  background: 'canvas',
  foreground: 'fg',
  card: 'surface',
  'card-foreground': 'fg',
  popover: 'surface-raised',
  'popover-foreground': 'fg',
  'primary-foreground': 'fg-on-primary',
  secondary: 'surface-sunken',
  'secondary-foreground': 'fg',
  muted: 'surface-sunken',
  'muted-foreground': 'fg-muted',
  accent: 'primary-subtle',
  'accent-foreground': 'primary',
  destructive: 'critical',
  input: 'border-strong',
};
for (const [alias, token] of Object.entries(shadcn)) {
  line(`  --color-${alias}: var(--nx-${token});`);
}
line('}');
line();

for (const [selector, mode, scheme] of [
  [':root', 'light', 'light'],
  ['[data-theme="dark"]', 'dark', 'dark'],
] as const) {
  line(`${selector} {`);
  line(`  color-scheme: ${scheme};`);
  for (const [token, value] of Object.entries(semanticTokens[mode])) {
    line(`  --nx-${token}: ${value};`);
  }
  line('}');
  line();
}

/* -------------------------------------------------------------------------- */
// THEME_OUT permite generarlo en otra ruta para revisarlo sin tocar dist/.
const target = process.env.THEME_OUT ?? join(__dirname, '..', 'dist', 'theme.css');
mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, out.join('\n'));

const tokenCount = out.filter((l) => /^\s+--/.test(l)).length;
console.log(`theme.css generado · ${tokenCount} variables → ${target}`);
