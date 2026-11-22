"use client";

import { useEffect } from "react";

/**
 * Registers the service worker (public/sw.js) in production only. The worker never caches pages, API calls or
 * anything private; see the header comment in public/sw.js. Renders nothing.
 */
export default function PwaRegister() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production" || !("serviceWorker" in navigator)) return;
    const register = () => { navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" }).catch(() => { /* installability is optional; the site works without it */ }); };
    if (document.readyState === "complete") register();
    else window.addEventListener("load", register, { once: true });
  }, []);
  return null;
}
