import type { Metadata, Viewport } from "next";
import { Cormorant_Garamond, Hanken_Grotesk } from "next/font/google";
import "./globals.css";
import { THEME_INIT_SCRIPT } from "@/lib/theme";
import AuthLinkForwarder from "@/components/AuthLinkForwarder";
import PwaRegister from "@/components/PwaRegister";

const display = Cormorant_Garamond({ subsets: ["latin"], weight: ["400", "500", "600"], variable: "--font-display-loaded", display: "swap" });
const body = Hanken_Grotesk({ subsets: ["latin"], variable: "--font-body-loaded", display: "swap" });

export const metadata: Metadata = {
  title: { default: "Vanta Transportation: Chauffeured travel", template: "%s | Vanta Transportation" },
  description: "Chauffeured transportation in black-on-black vehicles with clean, professional drivers.",
  applicationName: "Vanta Transportation",
  appleWebApp: { capable: true, title: "Vanta", statusBarStyle: "black-translucent" },
  icons: { icon: "/brand/vanta-mark.svg", apple: [{ url: "/icons/apple-touch-icon.png", sizes: "180x180", type: "image/png" }] },
};
export const viewport: Viewport = { themeColor: [{ media: "(prefers-color-scheme: light)", color: "#ffffff" }, { media: "(prefers-color-scheme: dark)", color: "#000000" }] };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${display.variable} ${body.variable}`} suppressHydrationWarning>
      <head><script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} /></head>
      <body><AuthLinkForwarder /><PwaRegister />{children}</body>
    </html>
  );
}
