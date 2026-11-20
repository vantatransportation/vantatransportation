import type { Metadata } from "next";

export const metadata: Metadata = { title: { default: "Driver", template: "%s | Vanta Driver" }, robots: { index: false, follow: false } };
export default function DriverLayout({ children }: { children: React.ReactNode }) {
  return <div style={{ maxWidth: 640, margin: "0 auto", padding: "1rem 1rem 4rem" }}>{children}</div>;
}
