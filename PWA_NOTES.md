# PWA support (installable app)

One app, one domain (https://vantatransportation.com). Customers, admins and drivers install and open the same site;
every route keeps its existing server-side authentication. Installing grants no access.

## Added
- `src/app/manifest.ts` – web app manifest (served at `/manifest.webmanifest`).
- `public/icons/*` – icon-192/512 (any), icon-maskable-192/512, apple-touch-icon (180), icon-32; rendered from `public/brand/vanta-mark.svg` on the brand black.
- `public/sw.js` – minimal service worker. Network-only for pages and all APIs; offline fallback page; caches only `/_next/static/*`, `/icons/*` and the brand mark. Ignores non-GET and cross-origin requests.
- `public/offline.html` – self-contained offline page.
- `src/components/PwaRegister.tsx` – registers the worker (production only).
- `src/components/InstallApp.tsx` – footer "Install app" action (native prompt where supported, short instructions otherwise, hidden once installed).
- `tests/pwa.test.ts` – 8 tests (manifest, icons, shortcuts, real `sw.js` run against mocked caches/fetch).

## Changed (minimal)
- `src/app/layout.tsx` – applicationName, Apple web-app meta, apple-touch icon, `<PwaRegister />`.
- `src/components/SiteFooter.tsx` – adds `<InstallApp />`.
- `src/app/globals.css` – `.install-app*` styles (appended after `.footer a:hover`).
- `next.config.ts` – no-cache headers for `/sw.js` and `/offline.html` so new deploys reach users.

No changes to auth, APIs, Supabase, payments, chat, Cloudinary, or the database.

## Test installation
Desktop Chrome: open the production URL → install icon in the address bar (or ⋮ → Cast, save and share → Install Vanta Transportation) → or footer "Install app".
Android Chrome: open the URL → ⋮ → Install app / Add to Home screen, or footer "Install app".
iPhone/iPad Safari: Share → Add to Home Screen (iOS has no install prompt API).
DevTools → Application → Manifest (no errors; icons load) and Service Workers (sw.js activated). Cache Storage should hold only `vanta-static-v1` with static files.
Deploy: push to the Vercel-connected branch as usual; no new env vars or dependencies. The service worker only registers in production builds over HTTPS.
