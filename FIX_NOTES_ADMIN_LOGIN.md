# Admin login fix

## Root cause
`POST /api/admin/login` collapsed every failure into one response, "Incorrect email or password." (401): a wrong password, an authenticated user missing from `admin_users`, an error reading `admin_users` (missing table, wrong service-role key), an unconfirmed email, and Supabase/API-key errors. The `admin_users` query result was also never checked for `error`, so a database error was treated as "not an admin".

The system is Supabase Auth (`signInWithPassword`, anon key) plus an authorization table (`admin_users`, read with the service-role key). Form field names (`email`, `password`) match the backend; there is no middleware/proxy file.

Which of those happened on your project cannot be determined from the ZIP alone (no Supabase access here). The most likely cause for a correct password is the manual setup step: the user exists in Supabase Auth but has no row in `admin_users` (the README INSERT silently inserts 0 rows if the email does not match). After this fix the login page tells you which case it is.

## Changes
- `src/app/api/admin/login/route.ts`: distinct status/message per failure (wrong credentials 401, unconfirmed email 403, not an admin 403, admin_users/database error 500, bad service key 503, auth/config error 502, rate limit 429, missing fields 400). Raw provider errors go to the server log only. Cookies are still set only when both authentication and authorization pass.
- `src/lib/supabase/admin.ts`: `serviceKeyProblem()` detects an anon/publishable key placed in `SUPABASE_SERVICE_ROLE_KEY` (shape check only; the key is never logged).
- `tests/admin-login.test.ts`: 8 tests for the above, session validation and logout state.
- `README.md`: table of sign-in messages and fixes.
No schema, UI, RLS, route or env-variable changes. `.env.example` unchanged.

## If you see "not authorized as an administrator"
In Supabase SQL editor (replace the email; do not change the password):
```sql
select id, email, email_confirmed_at from auth.users;           -- find the exact email
insert into public.admin_users (user_id, email)
select id, email from auth.users where lower(email) = lower('you@example.com')
on conflict (user_id) do nothing;
select * from public.admin_users;                                 -- should show your row
```
