// Driver invitation flow: the link Supabase redirects to, the origin it is built for, the password-setup API and the invite/resend API.
// Route handlers are the real ones, run against an in-memory Supabase stand-in. This does NOT prove a live Supabase project is configured
// correctly (Site URL / Redirect URLs); see FIX_NOTES_DRIVER_INVITE.md for those settings.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
// @ts-ignore: plain JS helper
import { FakeDb } from "./integration/fakedb.mjs";

const db: any = new FakeDb();
(globalThis as any).__fakeDb = db;
Object.assign(process.env, { NEXT_PUBLIC_SUPABASE_URL: "http://fake", SUPABASE_SERVICE_ROLE_KEY: "svc", NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon" });

const { parseInviteLink, forwardTarget } = await import("../src/lib/driver/invite-link.ts");
const { resolveSiteOrigin } = await import("../src/lib/site-url.ts");
const setPassword = await import("../src/app/api/driver/set-password/route.ts");
const invite = await import("../src/app/api/admin/drivers/invite/route.ts");

const JWT = "aaa.bbb.ccc";

// ---------- link parsing ----------
test("invitation hash with a token becomes a session", () => {
  const r = parseInviteLink(`#access_token=${JWT}&expires_in=3600&refresh_token=rt&token_type=bearer&type=invite`);
  assert.deepEqual(r, { kind: "session", accessToken: JWT, linkType: "invite" });
});

test("expired link (error in the hash) gives a specific, helpful message", () => {
  const r: any = parseInviteLink("#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired");
  assert.equal(r.kind, "error");
  assert.equal(r.code, "otp_expired");
  assert.match(r.message, /expired or has already been used/i);
});

test("error in the query string is understood too; a cut-off token is reported, not ignored", () => {
  assert.equal((parseInviteLink("", "?error=access_denied&error_code=otp_expired&error_description=x") as any).kind, "error");
  const bad: any = parseInviteLink("#access_token=truncated&type=invite");
  assert.equal(bad.kind, "error");
  assert.equal(bad.code, "malformed");
  assert.equal(parseInviteLink("").kind, "none");
  assert.equal(parseInviteLink("#main").kind, "none");
});

test("auth redirects that land on the wrong page are forwarded (token and error), ordinary pages are left alone", () => {
  assert.equal(forwardTarget({ pathname: "/", hash: `#access_token=${JWT}&type=invite`, search: "" }), `/driver/set-password#access_token=${JWT}&type=invite`);
  assert.equal(forwardTarget({ pathname: "/", hash: "#error=access_denied&error_code=otp_expired&error_description=Expired", search: "" })?.startsWith("/driver/set-password#error="), true);
  assert.equal(forwardTarget({ pathname: "/driver/set-password", hash: `#access_token=${JWT}&type=invite`, search: "" }), null);
  assert.equal(forwardTarget({ pathname: "/", hash: "", search: "" }), null);
  assert.equal(forwardTarget({ pathname: "/contact", hash: "#main", search: "?error=oops" }), null);
  assert.equal(forwardTarget({ pathname: "/", hash: `#access_token=${JWT}&type=something_else`, search: "" }), null);
});

// ---------- which origin goes in the emailed link ----------
const req = (url: string, headers: Record<string, string> = {}) => new Request(url, { headers });

test("a localhost NEXT_PUBLIC_SITE_URL is ignored on the live domain, so drivers are never sent to localhost", () => {
  const r = resolveSiteOrigin(req("https://vantatransportation.com/api/x", { origin: "https://vantatransportation.com", host: "vantatransportation.com" }), "http://localhost:3000");
  assert.deepEqual(r, { origin: "https://vantatransportation.com", source: "request" });
});

test("a real configured URL wins (trailing slash and path stripped); localhost is kept for local development", () => {
  assert.deepEqual(resolveSiteOrigin(req("https://x.test/api", { origin: "https://x.test" }), "https://vantatransportation.com/"), { origin: "https://vantatransportation.com", source: "env" });
  assert.deepEqual(resolveSiteOrigin(req("http://localhost:3000/api", { origin: "http://localhost:3000" }), "http://localhost:3000"), { origin: "http://localhost:3000", source: "env" });
  assert.equal(resolveSiteOrigin(req("http://localhost:3000/api", { origin: "http://localhost:3000" }), undefined)?.origin, "http://localhost:3000");
  assert.equal(resolveSiteOrigin(req("https://a.test/", { host: "a.test", "x-forwarded-proto": "https" }), "not a url")?.origin, "https://a.test");
});

// ---------- /api/driver/set-password ----------
let ip = 0;
const post = (handler: (r: Request) => Promise<Response>, url: string, body: unknown, headers: Record<string, string> = {}) =>
  handler(new Request(url, { method: "POST", headers: { "content-type": "application/json", origin: "https://vantatransportation.com", host: "vantatransportation.com", "x-forwarded-for": `10.1.0.${++ip}`, ...headers }, body: JSON.stringify(body) }));
const setPw = (body: unknown, headers?: Record<string, string>) => post(setPassword.POST, "https://vantatransportation.com/api/driver/set-password", body, headers);

let updated: { id: string; attrs: any }[] = [];
let signInResult: any;
let sent: { kind: string; email: string; redirectTo: string }[] = [];
let accounts: Record<string, any>;
let inviteResult: any;
let resetResult: any;

beforeEach(() => {
  db.tables = {};
  (globalThis as any).__cookies = {};
  updated = []; sent = [];
  signInResult = { data: { session: { access_token: "drv-at", refresh_token: "drv-rt", expires_in: 3600 }, user: { id: "user-1" } }, error: null };
  inviteResult = null; resetResult = { data: {}, error: null };
  accounts = { "user-1": { id: "user-1", email: "driver@x.com", email_confirmed_at: "2026-11-22T00:00:00Z" } };
  db.auth.getUser = async (t: string) => (t === "good" ? { data: { user: { id: "admin-1", email: "a@x.com" } }, error: null }
    : t === "drv-token" ? { data: { user: { id: "user-1", email: "driver@x.com" } }, error: null }
    : t === "admin-token" ? { data: { user: { id: "admin-1", email: "a@x.com" } }, error: null }
    : { data: { user: null }, error: { message: "expired" } });
  db.auth.signInWithPassword = async () => signInResult;
  db.auth.resetPasswordForEmail = async (email: string, o: any) => { sent.push({ kind: "recovery", email, redirectTo: o.redirectTo }); return resetResult; };
  db.auth.admin = {
    updateUserById: async (id: string, attrs: any) => { updated.push({ id, attrs }); return { data: {}, error: null }; },
    getUserById: async (id: string) => (accounts[id] ? { data: { user: accounts[id] }, error: null } : { data: { user: null }, error: { message: "not found" } }),
    inviteUserByEmail: async (email: string, o: any) => {
      sent.push({ kind: "invite", email, redirectTo: o.redirectTo });
      return inviteResult ?? { data: { user: { id: "user-new", email } }, error: null };
    },
  };
  db.seed("admin_users", [{ user_id: "admin-1", email: "a@x.com" }]);
  db.seed("drivers", [{ id: "11111111-1111-4111-8111-111111111111", full_name: "Dan Driver", email: "driver@x.com", user_id: "user-1", is_active: true }]);
});

test("check mode: a valid invitation token is accepted without a password and changes nothing", async () => {
  const res = await setPw({ accessToken: "drv-token", check: true });
  assert.equal(res.status, 200);
  assert.equal(updated.length, 0);
});

test("expired or used-up link: 401 with code 'expired' and a message that says what to do", async () => {
  const res = await setPw({ accessToken: "stale", check: true });
  assert.equal(res.status, 401);
  const body = await res.json();
  assert.equal(body.code, "expired");
  assert.match(body.error, /expired or was already used.*new invitation/i);
});

test("Supabase being down is reported as a temporary problem (503), not as an expired link", async () => {
  const real = db.auth.getUser;
  db.auth.getUser = async () => ({ data: { user: null }, error: { name: "AuthRetryableFetchError", status: 0, message: "fetch failed" } });
  const res = await setPw({ accessToken: "drv-token", check: true });
  db.auth.getUser = real;
  assert.equal(res.status, 503);
  assert.equal((await res.json()).code, "unavailable");
});

test("a token that is not an active driver (an admin, or a deactivated driver) can never set a password", async () => {
  assert.equal((await setPw({ accessToken: "admin-token", password: "correct horse battery" })).status, 403);
  db.tables.drivers[0].is_active = false;
  const res = await setPw({ accessToken: "drv-token", password: "correct horse battery" });
  assert.equal(res.status, 403);
  assert.equal(updated.length, 0);
});

test("valid link + password: password is set, driver is signed in with HttpOnly driver cookies, and it is logged", async () => {
  const res: any = await setPw({ accessToken: "drv-token", password: "correct horse battery" });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, signedIn: true });
  assert.deepEqual(updated, [{ id: "user-1", attrs: { password: "correct horse battery" } }]);
  assert.deepEqual(res._cookies.map((c: any[]) => c[0]), ["vd_at", "vd_rt"]);
  assert.equal(res._cookies[0][1], "drv-at");
  assert.equal(res._cookies[0][2].httpOnly, true);
  assert.ok(db.tables.activity_logs.some((l: any) => l.action === "driver.password_set"));
});

test("if signing in right after fails, the password is still set and the driver is told to sign in (no cookies)", async () => {
  signInResult = { data: { session: null, user: null }, error: { message: "boom", status: 500 } };
  const res: any = await setPw({ accessToken: "drv-token", password: "correct horse battery" });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, signedIn: false });
  assert.equal(res._cookies.length, 0);
  assert.equal(updated.length, 1);
});

test("short password 422; missing token 400; cross-origin request 403", async () => {
  assert.equal((await setPw({ accessToken: "drv-token", password: "short" })).status, 422);
  assert.equal((await setPw({ password: "correct horse battery" })).status, 400);
  assert.equal((await setPw({ accessToken: "drv-token", password: "correct horse battery" }, { origin: "https://evil.test" })).status, 403);
  assert.equal(updated.length, 0);
});

// ---------- /api/admin/drivers/invite ----------
const DRIVER_ID = "11111111-1111-4111-8111-111111111111";
const inviteReq = (body: unknown = { driverId: DRIVER_ID }) => post(invite.POST, "https://vantatransportation.com/api/admin/drivers/invite", body);
const asAdmin = () => { (globalThis as any).__cookies = { vt_at: "good" }; };

test("first invitation: link opens /driver/set-password on the origin the admin is using, even if the env var still says localhost", async () => {
  process.env.NEXT_PUBLIC_SITE_URL = "http://localhost:3000";
  asAdmin();
  db.tables.drivers[0].user_id = null;
  const res = await inviteReq();
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.opensAt, "https://vantatransportation.com/driver/set-password");
  assert.deepEqual(sent, [{ kind: "invite", email: "driver@x.com", redirectTo: "https://vantatransportation.com/driver/set-password" }]);
  assert.equal(db.tables.drivers[0].user_id, "user-new");
  delete process.env.NEXT_PUBLIC_SITE_URL;
});

test("invite needs an admin session, an active driver, and never links an administrator account", async () => {
  assert.equal((await inviteReq()).status, 401);
  asAdmin();
  db.tables.drivers[0].user_id = null;
  inviteResult = { data: { user: { id: "admin-1", email: "a@x.com" } }, error: null };
  assert.equal((await inviteReq()).status, 409);
  assert.equal(db.tables.drivers[0].user_id, null);
  db.tables.drivers[0].is_active = false;
  assert.equal((await inviteReq()).status, 422);
});

test("driver who accepted but needs a new link: a password-setup email is sent instead of 'already has an account'", async () => {
  asAdmin();
  const res = await inviteReq();
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.resent, true);
  assert.equal(body.method, "password-setup");
  assert.deepEqual(sent, [{ kind: "recovery", email: "driver@x.com", redirectTo: "https://vantatransportation.com/driver/set-password" }]);
  assert.ok(db.tables.activity_logs.some((l: any) => l.action === "driver.invite_resent"));
});

test("driver who never accepted: the invitation itself is re-sent", async () => {
  asAdmin();
  accounts["user-1"].email_confirmed_at = null;
  const res = await inviteReq();
  assert.equal((await res.json()).method, "invite");
  assert.deepEqual(sent.map((s) => s.kind), ["invite"]);
});

test("a resend never targets an administrator account, and email rate limits are reported plainly", async () => {
  asAdmin();
  db.tables.drivers[0].user_id = "admin-1";
  accounts["admin-1"] = { id: "admin-1", email: "a@x.com", email_confirmed_at: "x" };
  assert.equal((await inviteReq()).status, 409);
  assert.equal(sent.length, 0);

  db.tables.drivers[0].user_id = "user-1";
  resetResult = { data: null, error: { status: 429, code: "over_email_send_rate_limit", message: "email rate limit exceeded" } };
  const res = await inviteReq();
  assert.equal(res.status, 429);
  assert.match((await res.json()).error, /limiting how many emails/i);
});
