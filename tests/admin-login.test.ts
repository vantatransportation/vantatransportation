// Admin login: every failure mode must produce its own, accurate response (not "incorrect password" for all of them).
// Uses the real route handler with an in-memory Supabase stand-in. It does NOT prove a live Supabase project is configured correctly.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
// @ts-ignore: plain JS helper
import { FakeDb } from "./integration/fakedb.mjs";

const db: any = new FakeDb();
(globalThis as any).__fakeDb = db;
Object.assign(process.env, { NEXT_PUBLIC_SUPABASE_URL: "http://fake", SUPABASE_SERVICE_ROLE_KEY: "svc", NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon" });

const { POST } = await import("../src/app/api/admin/login/route.ts");
const { getAuthState } = await import("../src/lib/admin/auth.ts");

let ip = 0;
const login = (email: string, password: string, headers: Record<string, string> = {}) =>
  POST(new Request("http://site.test/api/admin/login", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://site.test", host: "site.test", "x-forwarded-for": `10.0.0.${++ip}`, ...headers },
    body: JSON.stringify({ email, password }),
  }));

type SignIn = { data: any; error: any };
let signIn: SignIn;
const session = { access_token: "good", refresh_token: "rt", expires_in: 3600 };
const okUser = { data: { session, user: { id: "admin-1", email: "a@x.com" } }, error: null };

beforeEach(() => {
  db.tables = {};
  db.auth.signInWithPassword = async () => signIn;
  db.seed("admin_users", [{ user_id: "admin-1", email: "a@x.com" }]);
  signIn = okUser;
  process.env.SUPABASE_SERVICE_ROLE_KEY = "svc";
});

test("valid admin: 200, sets session cookies, session then validates server-side", async () => {
  const res: any = await login("A@X.com", "pw");
  assert.equal(res.status, 200);
  const names = res._cookies.map((c: any[]) => c[0]);
  assert.deepEqual(names, ["vt_at", "vt_rt"]);
  assert.equal(res._cookies[0][2].httpOnly, true);
  (globalThis as any).__cookies = { vt_at: "good", vt_rt: "rt" };
  assert.equal((await getAuthState()).status, "ok");
  (globalThis as any).__cookies = {};
  assert.equal((await getAuthState()).status, "none");
});

test("wrong password: 401 invalid_credentials", async () => {
  signIn = { data: { session: null, user: null }, error: { code: "invalid_credentials", status: 400, message: "Invalid login credentials" } };
  const res = await login("a@x.com", "bad");
  assert.equal(res.status, 401);
  assert.equal((await res.json()).code, "invalid_credentials");
});

test("correct password but not in admin_users: 403 not_admin, no cookies", async () => {
  db.tables.admin_users = [];
  const res: any = await login("a@x.com", "pw");
  assert.equal(res.status, 403);
  const body = await res.json();
  assert.equal(body.code, "not_admin");
  assert.match(body.error, /not authorized/i);
  assert.equal(res._cookies.length, 0);
});

test("admin_users lookup error: 500, not reported as a password problem", async () => {
  const realFrom = db.from.bind(db);
  db.from = (t: string) => (t === "admin_users"
    ? { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: { code: "PGRST205", message: "no table" } }) }) }) }
    : realFrom(t));
  const res: any = await login("a@x.com", "pw");
  db.from = realFrom;
  assert.equal(res.status, 500);
  assert.equal((await res.json()).code, "admin_table_missing");
  assert.equal(res._cookies.length, 0);
});

test("unconfirmed email: 403 email_not_confirmed", async () => {
  signIn = { data: { session: null, user: null }, error: { code: "email_not_confirmed", status: 400, message: "Email not confirmed" } };
  const res = await login("a@x.com", "pw");
  assert.equal(res.status, 403);
  assert.equal((await res.json()).code, "email_not_confirmed");
});

test("auth service/config failure: 502 auth_service_error", async () => {
  signIn = { data: { session: null, user: null }, error: { status: 401, message: "Invalid API key" } };
  const res = await login("a@x.com", "pw");
  assert.equal(res.status, 502);
  assert.equal((await res.json()).code, "auth_service_error");
});

test("anon key pasted into SUPABASE_SERVICE_ROLE_KEY: 503 bad_service_key", async () => {
  const jwt = (role: string) => `h.${Buffer.from(JSON.stringify({ role })).toString("base64url")}.s`;
  process.env.SUPABASE_SERVICE_ROLE_KEY = jwt("anon");
  const res = await login("a@x.com", "pw");
  assert.equal(res.status, 503);
  assert.equal((await res.json()).code, "bad_service_key");
  process.env.SUPABASE_SERVICE_ROLE_KEY = jwt("service_role");
  assert.equal((await login("a@x.com", "pw")).status, 200);
});

test("cross-origin and missing fields are rejected", async () => {
  assert.equal((await login("a@x.com", "pw", { origin: "http://evil.test" })).status, 403);
  assert.equal((await login("", "")).status, 400);
});
