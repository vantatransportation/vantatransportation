import type { MetadataRoute } from "next";

/**
 * Web app manifest. One installable app for everyone: customers, admins and drivers all open the same origin, and
 * every protected route keeps enforcing its own server-side authentication. Installing grants no extra access.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: "Vanta Transportation",
    short_name: "Vanta",
    description: "Chauffeured transportation in black-on-black vehicles with clean, professional drivers.",
    lang: "en",
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "any",
    theme_color: "#000000",
    background_color: "#000000",
    categories: ["travel", "business"],
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/icon-maskable-192.png", sizes: "192x192", type: "image/png", purpose: "maskable" },
      { src: "/icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
    shortcuts: [
      { name: "Book a ride", short_name: "Book", url: "/book", icons: [{ src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" }] },
      { name: "Track your ride", short_name: "Track", url: "/track", icons: [{ src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" }] },
      { name: "Driver login", short_name: "Driver", url: "/driver/login", icons: [{ src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" }] },
    ],
  };
}
