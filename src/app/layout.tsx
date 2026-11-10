import type { Metadata, Viewport } from "next";
import { Cormorant_Garamond, Hanken_Grotesk } from "next/font/google";
import "./globals.css";
import { THEME_INIT_SCRIPT } from "@/lib/theme";

const display = Cormorant_Garamond({ subsets: ["latin"], weight: ["400", "500", "600"], variable: "--font-display-loaded", display: "swap" });
const body = Hanken_Grotesk({ subsets: ["latin"], variable: "--font-body-loaded", display: "swap" });

export const metadata: Metadata = {
  title: { default: "Vanta Transportation: Chauffeured travel", template: "%s | Vanta Transportation" },
  description: "Chauffeured transportation in black-on-black vehicles with clean, professional drivers.",
  icons: { icon: "/brand/vanta-mark.svg" },
};
export const viewport: Viewport = { themeColor: [{ media: "(prefers-color-scheme: light)", color: "#ffffff" }, { media: "(prefers-color-scheme: dark)", color: "#000000" }] };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${display.variable} ${body.variable}`} suppressHydrationWarning>
      <head><script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} /></head>
      <body>{children}</body>
    </html>
  );
}
