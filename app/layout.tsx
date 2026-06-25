import type { Metadata } from "next";
import "./globals.css";
import { theme } from "@/theme.config";

export const metadata: Metadata = {
  title: `${theme.appName}: ${theme.title}`,
  description: theme.tagline,
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
