import type { Config } from 'tailwindcss';

/**
 * Tailwind, driven by the Arus tokens rather than by shadcn's default slate.
 *
 * shadcn needs Tailwind, and Tailwind needs a palette. Taking the stock one would have
 * produced exactly the generic look the project's design rules forbid — so every colour
 * below resolves to a CSS variable defined in `tokens.css`, which still holds the Arus
 * values from UIUXDesign.md. The primitives are shadcn's; the identity stays ours.
 */
const config: Config = {
  darkMode: ['class'],
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    container: { center: true, padding: '1rem' },
    extend: {
      colors: {
        border: 'hsl(var(--border))',
        input: 'hsl(var(--input))',
        ring: 'hsl(var(--ring))',
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
        primary: { DEFAULT: 'hsl(var(--primary))', foreground: 'hsl(var(--primary-foreground))' },
        secondary: { DEFAULT: 'hsl(var(--secondary))', foreground: 'hsl(var(--secondary-foreground))' },
        destructive: { DEFAULT: 'hsl(var(--destructive))', foreground: 'hsl(var(--destructive-foreground))' },
        muted: { DEFAULT: 'hsl(var(--muted))', foreground: 'hsl(var(--muted-foreground))' },
        accent: { DEFAULT: 'hsl(var(--accent))', foreground: 'hsl(var(--accent-foreground))' },
        popover: { DEFAULT: 'hsl(var(--popover))', foreground: 'hsl(var(--popover-foreground))' },
        card: { DEFAULT: 'hsl(var(--card))', foreground: 'hsl(var(--card-foreground))' },
        /**
         * Arus semantics, kept as first-class names. `live` is the lime, and it is
         * reserved for live/active signals — an agent calling a tool is not one.
         */
        live: 'hsl(var(--arus))',
        succeeded: 'hsl(var(--status-succeeded-hsl))',
        failed: 'hsl(var(--status-failed-hsl))',
        running: 'hsl(var(--status-running-hsl))',
        retry: 'hsl(var(--status-retry-hsl))',
        rail: {
          trigger: 'hsl(var(--rail-trigger-hsl))',
          action: 'hsl(var(--rail-action-hsl))',
          logic: 'hsl(var(--rail-logic-hsl))',
        },
      },
      borderRadius: {
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 2px)',
        sm: 'calc(var(--radius) - 4px)',
      },
      fontFamily: {
        // Plus Jakarta Sans and IBM Plex Mono are already loaded via @fontsource.
        sans: ['var(--font-ui)'],
        mono: ['var(--font-mono)'],
      },
      keyframes: {
        'accordion-down': { from: { height: '0' }, to: { height: 'var(--radix-accordion-content-height)' } },
        'accordion-up': { from: { height: 'var(--radix-accordion-content-height)' }, to: { height: '0' } },
        'pulse-soft': { '0%, 100%': { opacity: '1' }, '50%': { opacity: '0.35' } },
      },
      animation: {
        'accordion-down': 'accordion-down 0.2s ease-out',
        'accordion-up': 'accordion-up 0.2s ease-out',
        'pulse-soft': 'pulse-soft 1.2s ease-in-out infinite',
      },
    },
  },
  plugins: [require('tailwindcss-animate')],
};

export default config;
