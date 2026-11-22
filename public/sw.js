/*
 * Vanta Transportation service worker. Deliberately minimal and safe.
 *
 *  - Pages, API calls, Supabase/auth traffic and everything private ALWAYS go straight to the network. Nothing
 *    dynamic is ever stored, so no booking, payment, tracking, chat, admin or driver data can be served stale.
 *  - The only thing cached is public, static, non-personal material: the offline page, the app icons/brand mark and
 *    Next.js's content-hashed /_next/static files (immutable by name).
 *  - If a page navigation fails because the device is offline, the cached offline page is shown instead.
 *  - Only GET requests to this origin are ever considered; POST/PATCH/PUT/DELETE are never touched.
 */
const VERSION = "v1";
const STATIC_CACHE = `vanta-static-${VERSION}`;
const OFFLINE_URL = "/offline.html";
const PRECACHE = [OFFLINE_URL, "/icons/icon-192.png", "/icons/icon-512.png", "/brand/vanta-mark.svg"];

// Public, non-personal, cacheable static paths. Anything else is not cached.
const isCacheableStatic = (url) =>
  url.pathname.startsWith("/_next/static/") || url.pathname.startsWith("/icons/") || url.pathname === "/brand/vanta-mark.svg" || url.pathname === "/brand/vanta-logo.png";

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(STATIC_CACHE).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith("vanta-") && k !== STATIC_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return; // never touch writes: the browser handles them normally
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // Supabase, Cloudinary, Stripe, PayPal, maps, etc. are not ours to cache

  // Page navigations: network only. Offline fallback page only if the network request itself fails.
  if (req.mode === "navigate") {
    event.respondWith(fetch(req).catch(() => caches.match(OFFLINE_URL).then((r) => r || Response.error())));
    return;
  }

  // Public static assets: cache-first (hashed /_next/static files never change content; icons are versioned by deploy).
  if (isCacheableStatic(url)) {
    event.respondWith(
      caches.match(req).then((hit) => {
        if (hit) return hit;
        return fetch(req).then((res) => {
          if (res.ok && res.type === "basic") { const copy = res.clone(); caches.open(STATIC_CACHE).then((c) => c.put(req, copy)); }
          return res;
        });
      }),
    );
  }
  // Everything else (including /api/*, RSC payloads, /admin, /driver, /trip, /pay) falls through to the network untouched.
});
