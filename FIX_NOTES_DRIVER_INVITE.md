# Driver invitation: blank page / "invalid link" fix

## How the flow actually works (read from the code, nothing assumed)
1. Admin > Drivers > **Send sign-in invitation** calls `POST /api/admin/drivers/invite` (`src/app/api/admin/drivers/invite/route.ts`), which calls Supabase `auth.admin.inviteUserByEmail(email, { redirectTo: "<site>/driver/set-password" })` and links the new auth user to `drivers.user_id`.
2. The driver clicks **Accept invitation** in the email. That is Supabase's own URL (`https://<project>.supabase.co/auth/v1/verify?token=…&type=invite&redirect_to=…`). Supabase validates the one-time token, then redirects the browser to `redirect_to`.
3. **`/driver/set-password`** (`src/app/driver/set-password/page.tsx` + `src/components/driver/SetPassword.tsx`) is the landing page. There is **no** `/auth/callback` or `/auth/confirm` route in this project. supabase-js defaults to the implicit flow, so the token arrives in the URL `#hash` (`#access_token=…&type=invite`), which only the browser can see.
4. The page posts the token and the new password to `POST /api/driver/set-password`. The server verifies the token with Supabase, requires it to belong to an ACTIVE driver, sets the password with the service-role client (server only), then (new) signs the driver in with the same `vd_at` / `vd_rt` HttpOnly cookies as `/api/driver/login` and the page goes to `/driver`.

## What was wrong
Confirmed by running the original component in a DOM (React StrictMode on and off) and by reading the routes:
1. **Valid links reported as invalid in `next dev`.** The page read the hash in an effect and erased it from the URL; React StrictMode runs effects twice, so the second run found no token. Any reload also lost the token.
2. **Every Supabase failure looked the same.** `#error=access_denied&error_code=otp_expired…` (expired, already used, or opened first by an email scanner) and `?error=` redirects were all shown as one generic line.
3. **A link that lands on the wrong page was dropped.** If the redirect URL is not on Supabase's allow-list, Supabase falls back to the **Site URL** and puts the token there (e.g. `/#access_token=…`). Nothing handled that, so the token vanished.
4. **The emailed origin could be localhost.** `redirectTo` came only from `NEXT_PUBLIC_SITE_URL`, which is inlined at build time and defaults to `http://localhost:3000` in `.env.example`. A production build made with that value emails a link to localhost, which opens nothing on a driver's phone.
5. **Not signed in afterwards, and no way to retry.** After setting a password the driver had to find the login page. The invite route linked `drivers.user_id` immediately, the Drivers screen only listed drivers without an account, and the route answered "already has an account", so one expired link could never be re-sent.
6. A Supabase outage was reported to the driver as "link expired".

**Not reproducible from the ZIP:** a literally blank page. The page itself renders a message in every state, so a blank screen means the browser never reached a working `/driver/set-password`: most likely the link went to `http://localhost:3000` (Site URL, or a localhost `NEXT_PUBLIC_SITE_URL`) which does not exist on the driver's device. I cannot see your Supabase dashboard or host settings, so the settings below must be checked there.

## Changes
- `src/lib/driver/invite-link.ts` (new): parses the redirect (hash or query) into a token or a specific error; decides when to forward a misplaced auth redirect.
- `src/components/driver/SetPassword.tsx`: captures the link once (kept for this tab only, survives StrictMode and reload), verifies it before showing the form, shows specific visible errors with next steps, "Try again" for temporary failures, and continues to `/driver` after saving.
- `src/app/driver/set-password/page.tsx`: message for browsers with JavaScript off.
- `src/components/AuthLinkForwarder.tsx` + `src/app/layout.tsx`: safety net that forwards an invitation token/error landing on any other page to `/driver/set-password`.
- `src/app/api/driver/set-password/route.ts`: `check` mode, distinct error codes (`expired`, `not_driver`, `unavailable`, …), signs the driver in after the password is set, logs `driver.password_set`. Same-origin check, rate limit and active-driver requirement kept.
- `src/lib/site-url.ts` (new) + `src/app/api/admin/drivers/invite/route.ts`: the link's origin is `NEXT_PUBLIC_SITE_URL` unless that is localhost and the admin is on a real domain, in which case the admin's own origin is used. Drivers who already have an account get a fresh link (invitation re-sent if never accepted, password-setup email otherwise); administrator accounts are never touched; email rate limits are reported plainly.
- `src/components/admin/DriverAccounts.tsx`: **Send new link** for drivers with an account; confirmation shows where the link opens.
- `tests/driver-invite.test.ts` (new, 18 tests), `README.md` (section 10), `.env.example` (comment only).
No schema, RLS, pricing, booking or admin-login changes. The service-role key stays server-side (`import "server-only"` in `supabase/admin.ts`; no client file imports it).

## Supabase settings (Authentication > URL Configuration)
- **Site URL:** `https://vantatransportation.com`
- **Redirect URLs:** `https://vantatransportation.com/driver/set-password`
- Local testing only: add `http://localhost:3000/driver/set-password`. Add `https://www.vantatransportation.com/driver/set-password` only if the site is served on `www`.
- Host environment: `NEXT_PUBLIC_SITE_URL=https://vantatransportation.com`, then redeploy.
- Email templates (Authentication > Email Templates): keep `{{ .ConfirmationURL }}` in **Invite user** and **Reset password**. If you ever switch to a custom link built from `{{ .TokenHash }}`, a server callback route would have to be added first; this project has none.
- Site URL being `http://localhost:3000` is what sends real drivers to localhost. Keep it only in the Redirect URL list for local work.
- The built-in Supabase email service is limited to a few emails per hour; for real drivers configure Custom SMTP (a verified sender/domain).
- Some mail apps open links before the person does, which uses up the one-time token. That now shows "expired or already used"; use **Send new link**.

## Verification
`npx tsc --noEmit` clean; `npm test` 195/195 (177 existing + 18 new); `next build` succeeds. The page logic was also exercised in jsdom under StrictMode against realistic redirect URLs. **Not verified:** a real Supabase project, real email delivery, or a real browser/phone; do one real invitation after changing the settings above.
