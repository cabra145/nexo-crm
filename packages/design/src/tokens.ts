/**
 * Sistema de diseño · tokens.
 *
 * Una sola fuente para color, tipografía, espaciado, radios y movimiento.
 * `scripts/build-theme.ts` genera con ellos `dist/theme.css`, que es la
 * configuración de Tailwind 4, y shadcn/ui se apoya en esas mismas variables.
 * **Ninguna pantalla declara un color literal.**
 *
 * Es lo que separa un producto de un conjunto de páginas que se parecen.
 *
 * ---------------------------------------------------------------------------
 * Sobre OKLCH
 *
 * Las escalas están en OKLCH y no en HSL porque en OKLCH la luminosidad es
 * perceptual: el paso 600 de verde y el 600 de rojo se ven igual de oscuros,
 * cosa que en HSL no ocurre ni de lejos. Eso importa de verdad al construir el
 * tema oscuro, donde con HSL hay que corregir a ojo color por color.
 *
 * Todos los navegadores que soporta Next 15 entienden oklch() de forma nativa.
 */

/* ========================================================================== */
/*  Color                                                                      */
/* ========================================================================== */

/**
 * Neutro con un sesgo mínimo hacia el verde azulado del primario.
 *
 * Un gris perfectamente neutro se lee como "sin decidir"; uno con un empujón
 * de tono hacia el acento se lee como elegido. El sesgo es deliberadamente
 * pequeño (croma 0.006–0.02): tiene que notarse junto al primario, no
 * parecer verde.
 */
export const neutral = {
  50: 'oklch(0.985 0.003 174)',
  100: 'oklch(0.967 0.004 174)',
  200: 'oklch(0.925 0.006 174)',
  300: 'oklch(0.867 0.008 174)',
  400: 'oklch(0.715 0.011 174)',
  500: 'oklch(0.573 0.013 174)',
  600: 'oklch(0.465 0.014 174)',
  700: 'oklch(0.385 0.014 174)',
  800: 'oklch(0.276 0.013 174)',
  900: 'oklch(0.212 0.012 174)',
  950: 'oklch(0.147 0.011 174)',
} as const;

/** Primario: verde azulado profundo. Acciones, estado activo, foco. */
export const primary = {
  50: 'oklch(0.972 0.021 174)',
  100: 'oklch(0.941 0.043 174)',
  200: 'oklch(0.883 0.079 174)',
  300: 'oklch(0.808 0.104 174)',
  400: 'oklch(0.718 0.113 174)',
  500: 'oklch(0.625 0.107 174)',
  600: 'oklch(0.527 0.093 174)',
  700: 'oklch(0.438 0.078 174)',
  800: 'oklch(0.363 0.063 174)',
  900: 'oklch(0.305 0.052 174)',
  950: 'oklch(0.203 0.038 174)',
} as const;

/* --------------------------------------------------------------------------
 *  Color semántico
 * ---------------------------------------------------------------------------
 *  Separado del primario a propósito. "Positivo" tiene que significar
 *  positivo, no "el color de la marca". Si el acento fuera verde y el éxito
 *  también, un botón primario parecería una confirmación.
 * ------------------------------------------------------------------------- */

/** Trato ganado, documento pagado, canal conectado. */
export const positive = {
  50: 'oklch(0.968 0.028 152)',
  100: 'oklch(0.930 0.058 152)',
  500: 'oklch(0.632 0.144 152)',
  600: 'oklch(0.535 0.126 152)',
  700: 'oklch(0.446 0.104 152)',
  900: 'oklch(0.288 0.068 152)',
} as const;

/** Tarea vencida, trato estancado, ventana de 24 h por cerrarse. */
export const warning = {
  50: 'oklch(0.977 0.032 85)',
  100: 'oklch(0.944 0.070 85)',
  500: 'oklch(0.722 0.152 85)',
  600: 'oklch(0.629 0.141 85)',
  700: 'oklch(0.524 0.119 85)',
  900: 'oklch(0.343 0.077 85)',
} as const;

/** Trato perdido, envío fallido, canal caído, borrado. */
export const critical = {
  50: 'oklch(0.971 0.018 25)',
  100: 'oklch(0.936 0.039 25)',
  500: 'oklch(0.598 0.207 25)',
  600: 'oklch(0.524 0.192 25)',
  700: 'oklch(0.445 0.164 25)',
  900: 'oklch(0.302 0.107 25)',
} as const;

/** Informativo: un aviso del sistema, una sugerencia de la IA. */
export const info = {
  50: 'oklch(0.972 0.018 245)',
  100: 'oklch(0.937 0.040 245)',
  500: 'oklch(0.612 0.169 245)',
  600: 'oklch(0.533 0.169 245)',
  700: 'oklch(0.452 0.146 245)',
  900: 'oklch(0.302 0.095 245)',
} as const;

/**
 * Paleta para etiquetas, etapas de embudo y series de gráfico.
 *
 * Ocho tonos con luminosidad y croma emparejados, así que ninguno grita por
 * encima de los demás y todos se leen sobre fondo claro y oscuro. El orden es
 * el de asignación automática: dos categorías contiguas nunca salen parecidas.
 */
export const categorical = [
  'oklch(0.625 0.107 174)', // verde azulado
  'oklch(0.612 0.169 245)', // azul
  'oklch(0.640 0.180 305)', // violeta
  'oklch(0.722 0.152 85)', // ámbar
  'oklch(0.632 0.144 152)', // verde
  'oklch(0.598 0.180 25)', // rojo
  'oklch(0.660 0.130 200)', // cian
  'oklch(0.600 0.140 340)', // rosa
] as const;

/* ========================================================================== */
/*  Tipografía                                                                 */
/* ========================================================================== */

export const fonts = {
  /**
   * Interfaz: Geist. Next.js la descarga UNA vez al compilar y la sirve desde
   * el propio dominio (`next/font`), así que el navegador del cliente nunca
   * pide nada a Google y no hay salto de fuente al cargar.
   */
  sans: 'var(--font-geist-sans), ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif',

  /**
   * Cifras, identificadores, números de documento y código.
   *
   * No es decoración: un número de factura, un teléfono o un id en tipografía
   * proporcional se leen mal y se comparan peor.
   */
  mono: 'var(--font-geist-mono), ui-monospace, "SF Mono", Menlo, Consolas, monospace',
} as const;

/**
 * Escala modular, razón 1.2, anclada en 14 px.
 *
 * 14 y no 16 porque esto es una herramienta de trabajo: tablas densas,
 * bandejas de conversación, tarjetas de Kanban. 16 px obligaría a desplazarse
 * el doble en las pantallas que más se usan.
 */
export const fontSize = {
  '2xs': ['0.6875rem', { lineHeight: '1rem', letterSpacing: '0.02em' }], // 11 · etiquetas
  xs: ['0.75rem', { lineHeight: '1.125rem' }], // 12 · metadatos
  sm: ['0.8125rem', { lineHeight: '1.25rem' }], // 13 · tablas
  base: ['0.875rem', { lineHeight: '1.375rem' }], // 14 · cuerpo
  lg: ['1rem', { lineHeight: '1.5rem' }], // 16
  xl: ['1.125rem', { lineHeight: '1.625rem', letterSpacing: '-0.01em' }],
  '2xl': ['1.375rem', { lineHeight: '1.875rem', letterSpacing: '-0.015em' }],
  '3xl': ['1.75rem', { lineHeight: '2.125rem', letterSpacing: '-0.02em' }],
  '4xl': ['2.25rem', { lineHeight: '2.5rem', letterSpacing: '-0.025em' }],
} as const;

/* ========================================================================== */
/*  Espacio y forma                                                            */
/* ========================================================================== */

/** Retícula de 4 px. Todo espaciado es múltiplo suyo. */
export const spacingUnit = 4;

/**
 * Tres radios, no siete.
 *
 * Más variedad no da más expresividad: da inconsistencia. `sm` para controles
 * pequeños, `md` para casi todo, `lg` para superficies que flotan.
 */
export const radius = {
  sm: '0.25rem',
  md: '0.375rem',
  lg: '0.625rem',
  full: '9999px',
} as const;

/**
 * Dos elevaciones.
 *
 * La sombra se reserva para lo que de verdad flota: menús, diálogos, y la
 * tarjeta mientras se arrastra. Una sombra en cada tarjeta aplana la jerarquía
 * en vez de crearla — si todo está elevado, nada destaca.
 */
export const shadow = {
  /** Menús desplegables, popovers, tarjeta arrastrándose. */
  raised: '0 1px 2px oklch(0 0 0 / 0.06), 0 4px 12px -4px oklch(0 0 0 / 0.12)',
  /** Diálogos y paneles laterales. */
  overlay: '0 2px 4px oklch(0 0 0 / 0.08), 0 16px 40px -12px oklch(0 0 0 / 0.24)',
} as const;

/* ========================================================================== */
/*  Movimiento                                                                 */
/* ========================================================================== */

/**
 * Tres duraciones y una curva.
 *
 * La restricción es el punto: animaciones con duraciones arbitrarias hacen que
 * el producto se sienta improvisado. Todo lo que se anima respeta además
 * `prefers-reduced-motion`.
 */
export const motion = {
  duration: {
    /** Cambio de estado inmediato: hover, foco, pulsación. */
    fast: 120,
    /** Aparición y desaparición: menús, tooltips, toasts. */
    normal: 180,
    /** Desplazamiento de superficie: paneles laterales, diálogos. */
    slow: 240,
  },
  /** Sale rápido y frena al llegar. Se percibe como respuesta, no como espera. */
  easing: 'cubic-bezier(0.32, 0.72, 0, 1)',
} as const;

/* ========================================================================== */
/*  Aplicación del tema                                                        */
/* ========================================================================== */

/**
 * Los tokens semánticos: lo que los componentes usan de verdad.
 *
 * Un componente nunca pide `neutral[800]`; pide `bg-surface` o `text-muted`.
 * Así el tema oscuro se define una vez aquí y no hay que revisar componente
 * por componente.
 */
export const semanticTokens = {
  light: {
    canvas: neutral[100],
    surface: 'oklch(1 0 0)',
    'surface-sunken': neutral[50],
    'surface-raised': 'oklch(1 0 0)',

    border: neutral[200],
    'border-strong': neutral[300],

    fg: neutral[900],
    'fg-muted': neutral[600],
    'fg-faint': neutral[500],
    'fg-on-primary': 'oklch(1 0 0)',

    primary: primary[600],
    'primary-hover': primary[700],
    'primary-subtle': primary[50],

    positive: positive[600],
    'positive-subtle': positive[50],
    warning: warning[600],
    'warning-subtle': warning[50],
    critical: critical[600],
    'critical-subtle': critical[50],
    info: info[600],
    'info-subtle': info[50],

    /** Anillo de foco. Visible siempre: la navegación por teclado no es opcional. */
    ring: primary[500],
  },

  /**
   * El tema oscuro NO es el claro invertido.
   *
   * Dos correcciones que hay que hacer a mano y que se notan enseguida:
   *   · El primario sube de luminosidad (600 → 400). El 600 sobre fondo
   *     oscuro no llega al contraste mínimo.
   *   · Las superficies se separan por luminosidad y no por sombra: sobre
   *     fondo oscuro una sombra no se ve, así que lo que eleva es el color.
   */
  dark: {
    canvas: neutral[950],
    surface: neutral[900],
    'surface-sunken': 'oklch(0.118 0.010 174)',
    'surface-raised': neutral[800],

    border: 'oklch(0.268 0.012 174)',
    'border-strong': neutral[700],

    fg: neutral[100],
    'fg-muted': neutral[400],
    'fg-faint': neutral[500],
    'fg-on-primary': neutral[950],

    primary: primary[400],
    'primary-hover': primary[300],
    'primary-subtle': primary[950],

    positive: 'oklch(0.720 0.130 152)',
    'positive-subtle': positive[900],
    warning: 'oklch(0.800 0.130 85)',
    'warning-subtle': warning[900],
    critical: 'oklch(0.700 0.170 25)',
    'critical-subtle': critical[900],
    info: 'oklch(0.700 0.140 245)',
    'info-subtle': info[900],

    ring: primary[400],
  },
} as const;

export type ThemeMode = keyof typeof semanticTokens;
export type SemanticToken = keyof (typeof semanticTokens)['light'];
