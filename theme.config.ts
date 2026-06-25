// ---------------------------------------------------------------------------
// Launchpad theming / branding — the single place an adopter rebrands.
//
// Edit THIS file (text below) and the matching CSS variables in app/globals.css
// (the UI colors) to make the waitlist your own. Nothing else in the app needs
// to change. The values here drive: page <title>/metadata, the public page
// header + footer, and the accent color used in transactional emails (emails
// can't read CSS variables, so the accent hex lives here too).
// ---------------------------------------------------------------------------

export const theme = {
  /** Product/brand name shown in the title bar and headings. */
  appName: "Launchpad",
  /** Browser tab + social title. */
  title: "Join the Waitlist",
  /** One-line description / tagline under the heading and in <meta>. */
  tagline: "Sign up to get early access. Refer friends to jump the line.",
  /** Footer attribution. Set href to your own site if you like. */
  footer: {
    label: "Launchpad",
    href: "https://github.com/martello-systems/launchpad",
  },
  /**
   * Accent color used by HTML emails (buttons, code text). Keep this in sync
   * with the --brand CSS variable in app/globals.css. Emails are sent as static
   * HTML so they can't reference CSS variables — hence a literal hex here.
   */
  email: {
    accent: "#111111",
    accentFg: "#ffffff",
  },
} as const;

export type Theme = typeof theme;
