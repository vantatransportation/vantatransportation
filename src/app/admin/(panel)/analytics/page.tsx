import Link from "next/link";
import { adminPage } from "@/lib/admin/data";
import { BUSINESS_TZ } from "@/lib/config";
import BarChart from "@/components/admin/BarChart";
import { fmtMoney } from "@/components/admin/util";
import { MAX_ROWS, completedByMonth, monthKey, driverTable, lastMonths, paymentSummary, ratingTrend, upcomingRides } from "@/lib/analytics";

export const metadata = { title: "Analytics" };

/** Read-only, admin-only analytics over existing records. See docs/PROPOSALS.md (Phase 4) for every definition. */
export default async function Analytics({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { db } = await adminPage();
  const sp = await searchParams;
  const raw = Number(Array.isArray(sp.months) ? sp.months[0] : sp.months);
  const n = [3, 6, 12].includes(raw) ? raw : 6;
  const nowMs = new Date().getTime();
  const months = lastMonths(n, nowMs, BUSINESS_TZ);
  const since = new Date(nowMs - (n + 1) * 31 * 86400_000).toISOString(); // slightly wider than the window; month buckets do the exact cut in the business time zone
  const [bk, up, rt, dr, py] = await Promise.all([
    db.from("bookings").select("status,pickup_at,driver_id").gte("pickup_at", since).lte("pickup_at", new Date(nowMs).toISOString()).limit(MAX_ROWS),
    db.from("bookings").select("status,pickup_at,driver_id").gt("pickup_at", new Date(nowMs).toISOString()).in("status", ["confirmed", "assigned", "getting_ready"]).limit(MAX_ROWS),
    db.from("driver_ratings").select("driver_id,stars,created_at").limit(MAX_ROWS),
    db.from("drivers").select("id,full_name,performance_points,is_active").limit(500),
    db.from("payments").select("status,amount_cents,provider,created_at").gte("created_at", since).limit(MAX_ROWS),
  ]);
  const past = (bk.data ?? []) as { status: string; pickup_at: string; driver_id: string | null }[];
  const future = (up.data ?? []) as typeof past;
  const ratings = (rt.data ?? []) as { driver_id: string; stars: number; created_at: string }[];
  const drivers = (dr.data ?? []) as { id: string; full_name: string; performance_points: number | null; is_active: boolean | null }[];
  const payments = ((py.data ?? []) as { status: string; amount_cents: number; provider: string; created_at: string }[]).filter((p) => months.includes(monthKey(p.created_at, BUSINESS_TZ)));
  const truncated = [past.length, future.length, ratings.length, payments.length].some((c) => c >= MAX_ROWS);
  const completed = completedByMonth(past, months, BUSINESS_TZ);
  const upcoming = upcomingRides(future, nowMs);
  const trend = ratingTrend(ratings, months, BUSINESS_TZ);
  const table = driverTable(drivers, ratings, past.filter((b) => months.includes(monthKey(b.pickup_at, BUSINESS_TZ))));
  const pay = paymentSummary(payments);
  const windowCompleted = completed.reduce((a, c) => a + c.value, 0);

  return (
    <>
      <h1>Analytics</h1>
      <p className="adm-sub">Real records only. Months are in {BUSINESS_TZ}. Nothing is estimated or back-filled: a month with no records shows zero or &quot;no data&quot;.</p>
      <p style={{ display: "flex", gap: ".5rem", flexWrap: "wrap" }}>
        {[3, 6, 12].map((m) => <Link key={m} href={`/admin/analytics?months=${m}`} className={`btn ${m === n ? "btn--primary" : "btn--ghost"}`} aria-current={m === n ? "true" : undefined}>Last {m} months</Link>)}
      </p>
      {truncated && <p className="notice notice--error">One of the queries reached its {MAX_ROWS}-row limit, so some figures may be understated. Narrow the range.</p>}

      <div className="cards" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(11rem,1fr))", gap: ".75rem", margin: "1rem 0" }}>
        {[["Completed rides", String(windowCompleted), `last ${n} months`], ["Upcoming rides", String(upcoming.total), `${upcoming.next7Days} in the next 7 days`], ["Payment success rate", pay.successRate == null ? "no data" : `${pay.successRate}%`, `${pay.succeeded} succeeded · ${pay.failed} failed`], ["Collected", fmtMoney(pay.collectedCents), "paid payments, last " + n + " months"]].map(([t, v, s]) => (
          <div key={t} className="panel"><p className="muted" style={{ fontSize: ".8rem" }}>{t}</p><p style={{ fontSize: "1.6rem", fontWeight: 700 }}>{v}</p><p className="muted" style={{ fontSize: ".8rem" }}>{s}</p></div>
        ))}
      </div>

      <section className="panel" aria-label="Completed rides"><h2>Completed rides per month</h2><BarChart title="Completed rides per month" data={completed.map((c) => ({ label: c.label, value: c.value }))} /></section>
      <section className="panel" style={{ marginTop: "1rem" }} aria-label="Rating trend"><h2>Average customer rating per month</h2><BarChart title="Average customer star rating per month (1 to 5)" data={trend.map((t) => ({ label: t.label, value: t.avg }))} max={5} decimals={1} /><p className="muted" style={{ fontSize: ".85rem" }}>Based on {trend.reduce((a, t) => a + t.count, 0)} ratings. A month with no ratings shows &quot;no data&quot;, not zero.</p></section>

      <section className="panel" style={{ marginTop: "1rem" }} aria-label="Drivers">
        <h2>Drivers: ratings and points</h2>
        <p className="muted">Star ratings (all time) come from customers; points are set by admins. They are separate and never calculated from each other. Completed rides cover the last {n} months.</p>
        {table.length === 0 ? <p className="muted">No drivers yet.</p> : (
          <>
            <BarChart title="Driver performance points (0 to 100)" data={table.filter((d) => d.points != null).slice(0, 12).map((d) => ({ label: d.name.split(" ")[0] ?? d.name, value: d.points }))} max={100} />
            <div className="tbl-wrap"><table className="tbl"><thead><tr><th>Driver</th><th>Avg stars</th><th>Reviews</th><th>Points</th><th>Completed</th></tr></thead><tbody>
              {table.map((d) => <tr key={d.id}><td>{d.name}{d.active ? "" : " (inactive)"}</td><td>{d.avgStars == null ? "no ratings" : `★ ${d.avgStars.toFixed(1)}`}</td><td>{d.reviews}</td><td>{d.points ?? "—"}</td><td>{d.completed}</td></tr>)}
            </tbody></table></div>
          </>
        )}
      </section>

      <section className="panel" style={{ marginTop: "1rem" }} aria-label="Payments">
        <h2>Payments (last {n} months)</h2>
        <p className="muted">Succeeded = paid, partially refunded or refunded (money was collected). Failed = failed, capture failed or authorization expired. Open = pending, authorized (held, not charged) or capture in progress.</p>
        {pay.byStatus.length === 0 ? <p className="muted">No payments in this period.</p> : (
          <div className="tbl-wrap"><table className="tbl"><thead><tr><th>Status</th><th>Payments</th></tr></thead><tbody>{pay.byStatus.map(([s, c]) => <tr key={s}><td>{s.replace(/_/g, " ")}</td><td>{c}</td></tr>)}</tbody></table></div>
        )}
        <p className="muted">Held but not yet charged: {fmtMoney(pay.heldCents)}. Needs review: {pay.review}.</p>
      </section>
    </>
  );
}
