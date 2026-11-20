// Minimal in-memory stand-in for the parts of supabase-js the app uses.
import { randomUUID } from "node:crypto";

const REL = {
  vehicles: { vehicle_categories: ["one", "category_id", "vehicle_categories"], vehicle_tiers: ["one", "tier_id", "vehicle_tiers"], pricing_configs: ["many", "vehicle_id", "pricing_configs"] },
  pricing_configs: { pricing_surcharges: ["many", "pricing_config_id", "pricing_surcharges"], vehicles: ["one", "vehicle_id", "vehicles"] },
  bookings: { vehicles: ["one", "vehicle_id", "vehicles"], customers: ["one", "customer_id", "customers"] },
  quote_requests: { vehicles: ["one", "vehicle_id", "vehicles"] },
};
const UNIQUE = { customers: ["email_normalized"], bookings: ["submission_key", "reference"], quote_requests: ["submission_key", "access_token"], notification_logs: ["dedupe_key"], admin_notifications: ["dedupe_key"], stripe_events: ["id"], paypal_events: ["id"], payments: ["stripe_session_id"], booking_messages: ["dedupe_key"] };

function splitTop(s) { const out = []; let d = 0, cur = ""; for (const ch of s) { if (ch === "(") d++; if (ch === ")") d--; if (ch === "," && d === 0) { out.push(cur.trim()); cur = ""; } else cur += ch; } if (cur.trim()) out.push(cur.trim()); return out; }

export class FakeDb {
  constructor() { this.tables = {}; this.seq = 1000; this.auth = { getUser: async (t) => (t === "good" ? { data: { user: { id: "admin-1", email: "a@x.com" } }, error: null } : /^drv-/.test(t ?? "") ? { data: { user: { id: "user-" + t, email: t + "@d.test" } }, error: null } : { data: { user: null }, error: { message: "bad" } }), admin: { updateUserById: async () => ({ error: null }) } }; this.storage = {}; }
  t(name) { return (this.tables[name] ??= []); }
  seed(name, rows) { for (const r of rows) this.t(name).push({ id: randomUUID(), created_at: new Date().toISOString(), ...r }); }
  from(name) { return new Query(this, name); }
  embed(table, row, sel) {
    const out = { ...row };
    for (const item of splitTop(sel)) {
      const m = item.match(/^(\w+)\((.*)\)$/s);
      if (!m) continue;
      const rel = REL[table]?.[m[1]];
      if (!rel) continue;
      const [kind, fk, target] = rel;
      if (kind === "one") { const r = this.t(target).find((x) => x.id === row[fk]); out[m[1]] = r ? this.embed(target, r, m[2]) : null; }
      else out[m[1]] = this.t(target).filter((x) => x[fk] === row.id).map((x) => this.embed(target, x, m[2]));
    }
    return out;
  }
}

class Query {
  constructor(db, table) { this.db = db; this.table = table; this.op = "select"; this.f = []; this.sel = "*"; this.ord = null; this.lim = null; this.head = false; this.countMode = false; }
  select(cols = "*", opts = {}) { this.sel = cols; if (opts.head) this.head = true; if (opts.count) this.countMode = true; return this; }
  insert(p) { this.op = "insert"; this.p = p; return this; }
  upsert(p) { this.op = "upsert"; this.p = p; return this; }
  update(p) { this.op = "update"; this.p = p; return this; }
  delete() { this.op = "delete"; return this; }
  eq(c, v) { this.f.push((r) => r[c] === v); return this; }
  neq(c, v) { this.f.push((r) => r[c] !== v); return this; }
  in(c, v) { this.f.push((r) => v.includes(r[c])); return this; }
  ilike(c, v) { this.f.push((r) => String(r[c] ?? "").toLowerCase() === String(v).toLowerCase()); return this; }
  is(c, v) { this.f.push((r) => (v === null ? r[c] == null : r[c] === v)); return this; }
  lt(c, v) { this.f.push((r) => r[c] < v); return this; }
  not(c, op, v) { this.f.push((r) => !(op === "is" && v === null ? r[c] == null : r[c] === v)); return this; }
  order(c, o = {}) { this.ord = [c, o.ascending !== false]; return this; }
  limit(n) { this.lim = n; return this; }
  maybeSingle() { this.mode = "maybe"; return this.run(); }
  single() { this.mode = "single"; return this.run(); }
  then(res, rej) { return this.run().then(res, rej); }

  async run() {
    const db = this.db; const rows = db.t(this.table);
    const match = () => rows.filter((r) => this.f.every((fn) => fn(r)));
    let result; let error = null;
    if (this.op === "insert") {
      const list = Array.isArray(this.p) ? this.p : [this.p]; result = [];
      for (const raw of list) {
        const row = { id: randomUUID(), created_at: new Date().toISOString(), updated_at: new Date().toISOString(), ...raw };
        if (this.table === "customers") { row.email_normalized = row.email ? row.email.trim().toLowerCase() : null; row.phone_digits = row.phone ? row.phone.replace(/\D/g, "").slice(-10) || null : null; row.status ??= "active"; }
        if (this.table === "bookings") { row.reference ??= "VT-" + ++db.seq; row.status ??= "new_request"; row.payment_token ??= randomUUID(); row.amount_paid_cents ??= 0; row.child_seat_fee_cents ??= 0; row.payment_status ??= "not_required"; }
        if (this.table === "payments") { row.refunded_cents ??= 0; row.status ??= "pending"; }
        if (this.table === "quote_requests") { row.access_token ??= randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, ""); row.status ??= "new"; row.customer_response ??= "pending"; row.discount_decision ??= "pending"; }
        if (this.table === "notification_logs") { row.attempts ??= 0; }
        // booking_assignments: at most one OPEN assignment (unassigned_at is null) per booking, like the partial unique index.
        if (this.table === "booking_assignments" && row.unassigned_at == null && rows.some((x) => x.booking_id === row.booking_id && x.unassigned_at == null)) { error = { code: "23505", message: "duplicate open assignment" }; result = null; break; }
        const dup = (UNIQUE[this.table] ?? []).find((c) => row[c] != null && rows.some((x) => x[c] === row[c]));
        if (dup) { error = { code: "23505", message: "duplicate " + dup }; result = null; break; }
        rows.push(row); result.push(row);
      }
    } else if (this.op === "upsert") {
      const list = Array.isArray(this.p) ? this.p : [this.p]; result = [];
      for (const raw of list) {
        const ex = rows.find((x) => x.notification_id === raw.notification_id && x.user_id === raw.user_id);
        if (!ex) { const row = { created_at: new Date().toISOString(), ...raw }; rows.push(row); result.push(row); }
      }
    } else if (this.op === "update") {
      result = match(); result.forEach((r) => Object.assign(r, this.p, { updated_at: new Date().toISOString() }));
    } else if (this.op === "delete") {
      const del = match(); del.forEach((r) => rows.splice(rows.indexOf(r), 1)); result = del;
    } else {
      result = match();
      if (this.ord) { const [c, asc] = this.ord; result = [...result].sort((a, b) => (a[c] > b[c] ? 1 : a[c] < b[c] ? -1 : 0) * (asc ? 1 : -1)); }
      if (this.lim != null) result = result.slice(0, this.lim);
      result = result.map((r) => db.embed(this.table, r, this.sel));
    }
    const count = Array.isArray(result) ? result.length : 0;
    if (this.head) return { data: null, error, count };
    if (this.mode === "maybe") return { data: result?.[0] ?? null, error, count };
    if (this.mode === "single") return result?.[0] ? { data: result[0], error } : { data: null, error: error ?? { code: "PGRST116", message: "no rows" } };
    return { data: result, error, count };
  }
}
