import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      // Brand tokens backed by CSS variables defined in app/globals.css.
      // Rebrand by editing those variables (and theme.config.ts for text/email
      // accent); components reference `brand` / `brand-hover` / `brand-fg`.
      colors: {
        brand: {
          DEFAULT: "var(--brand)",
          hover: "var(--brand-hover)",
          fg: "var(--brand-fg)",
        },
      },
    },
  },
  plugins: [],
};

export default config;
