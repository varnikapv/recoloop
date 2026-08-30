import type { Metadata } from "next";
import type { ReactNode } from "react";
import { IBM_Plex_Mono, IBM_Plex_Sans } from "next/font/google";

import "./globals.css";

/**
 * IBM Plex, self-hosted by next/font so a live demo never waits on a font CDN.
 * A designed superfamily with true tabular figures: the sans carries labels,
 * the mono carries every identifier and every amount so columns align on the
 * digit, which is the whole ergonomic argument for a reconciliation tool.
 */
const sans = IBM_Plex_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-sans",
  display: "swap",
});

const mono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "RecoLoop — exception review",
  description: "Reviewer queue for unreconciled payment settlement cases",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
