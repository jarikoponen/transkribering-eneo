import type { Config } from "tailwindcss";

// Preset från komponentbiblioteket (tokens, färger, typografi, spacing).
const skPreset = require("@sk-web-gui/core").preset();

const config: Config = {
  presets: [skPreset],
  darkMode: "class",
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
    "./node_modules/@sk-web-gui/*/dist/**/*.js",
  ],
  theme: {
    extend: {
      fontFamily: {
        // sans/header/display ärvs från SK-preseten (Arial brödtext, Raleway rubriker).
        mono: ["Geist Mono", "ui-monospace", "monospace"],
      },
      colors: {
        bg: "hsl(var(--bg))",
        "bg-2": "hsl(var(--bg-2))",
        paper: "hsl(var(--paper))",
        ink: {
          DEFAULT: "hsl(var(--ink))",
          soft: "hsl(var(--ink-soft))",
          mute: "hsl(var(--ink-mute))",
        },
        rule: {
          DEFAULT: "hsl(var(--rule))",
          soft: "hsl(var(--rule-soft))",
        },
        // App-egen brand-/CTA-färg. Krockar inte med SK:s color-scopade
        // accent-ytor som komponenterna använder.
        accent: {
          DEFAULT: "hsl(var(--accent))",
          soft: "hsl(var(--accent-soft))",
          foreground: "hsl(var(--paper))",
        },
        record: "hsl(var(--record))",
        ochre: "hsl(var(--ochre))",
      },
      // SK-preseten sätter en tjock default-border (--sk-spacing-2). Återställ
      // till 1px så Tailwinds `border`-klass matchar .paper-card (hårdkodad 1px)
      // och linjerna blir lika tunna överallt.
      borderWidth: {
        DEFAULT: "1px",
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
      },
      boxShadow: {
        "accent-glow": "0 18px 40px -10px hsl(var(--accent) / 0.18)",
      },
    },
  },
  plugins: [require("@tailwindcss/typography")],
};

export default config;
