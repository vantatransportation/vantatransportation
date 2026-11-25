import Link from "next/link";
import { adminPage } from "@/lib/admin/data";
import { configWarnings } from "@/lib/notify";
import { BUSINESS_TZ } from "@/lib/config";
import { getHelpline } from "@/lib/helpline";
import { fmtDate, fmtMoney } from "@/components/admin/util";
import { loadUnacknowledgedRides } from "@/lib/admin/acknowledgement";

export const metadata = { title: "Overview" };

export default async function Overview() {
  const { db } = await adminPage();
  const nowIso = new Date().toISOString();
  const count = async (table: string, f?: (q: any) => any) => { // eslint-disable-line @typescript-eslint/no-explicit-any
    let q: any = db.from(table).select("id", { count: "exact", head: true }); // eslint-disable-line @typescript-eslint/no-explicit-any
    if (f) q = f(q);
    const { count: c } = await q;
    return (c as number | null) ?? 0;
  };

  const [customers, newLeads, pendingLeads, newBookings, confirmed, completed, openQuotes, overdue, value, activity] = await Promise.all([
    count("customers"),
    count("leads", (q) => q.eq("status", "new")),
    count("leads", (q) => q.in("status", ["new", "contacted", "follow_up"])),
    count("bookings", (q) => q.eq("status", "new_request")),
    count("bookings", (q) => q.in("status", ["confirmed", "assigned", "in_progress"])),
    count("bookings", (q) => q.eq("status", "completed")),
    count("quote_requests", (q) => q.in("status", ["new", "reviewing"])),
    count("follow_ups", (q) => q.is("completed_at", null).lt("due_at", nowIso)),
    db.from("bookings").select("estimated_fare_cents").neq("status", "cancelled").not("estimated_fare_cents", "is", null).limit(10000),
    db.from("activity_logs").select("id,action,created_at,entity_type").order("created_at", { ascending: false }).limit(12),
  ]);
  const totalValue = ((value.data ?? []) as { estimated_fare_cents: number }[]).reduce((s, r) => s + r.estimated_fare_cents, 0);
  const unacknowledged = await loadUnacknowledgedRides(db);
  const warnings = configWarnings();
  if (!(await getHelpline(db))) warnings.push({ channel: "email", message: "The Vanta support (helpline) phone number is not set. Customers and drivers see no Call Vanta Support button until you add it under Website content (contact.phone)." });

  const stats: [string, string | number, boolean?][] = [
    ["Total customers", customers], ["New leads", newLeads], ["Pending inquiries", pendingLeads], ["New booking requests", newBookings],
    ["Confirmed / active bookings", confirmed], ["Completed trips", completed], ["Open quote requests", openQuotes],
    ["Overdue follow-ups", overdue, overdue > 0], ["Booking value (non-cancelled)", fmtMoney(totalValue)],
  ];

  return (
    <>
      <h1>Overview</h1>
      <p className="adm-sub">Live figures from your database.</p>
      {warnings.map((w) => <div key={w.message} className="banner">{w.message} <Link href="/admin/settings" style={{ textDecoration: "underline" }}>Settings</Link></div>)}
      <div className="cards">
        {stats.map(([l, v, warn]) => <div key={l} className={`stat${warn ? " stat--warn" : ""}`}><b>{v}</b><span>{l}</span></div>)}
      </div>
      <div className="panel" aria-label="Rides awaiting driver acknowledgement">
        <h3>Upcoming rides the driver has not acknowledged</h3>
        <p className="muted">Confirmed and paid rides where the driver has not tapped Getting Ready yet. Earliest pickup first.</p>
        {unacknowledged.length === 0 ? <p className="muted">Every upcoming ride has been acknowledged.</p> : (
          <div className="tbl-wrap"><table className="tbl"><thead><tr><th>Pickup</th><th>Booking</th><th>Driver</th><th>Phone</th><th>In</th></tr></thead><tbody>
            {unacknowledged.map((r) => (
              <tr key={r.id}><td style={{ whiteSpace: "nowrap" }}>{fmtDate(r.pickupAt, BUSINESS_TZ)}</td><td><Link href={`/admin/bookings/${r.id}`}>{r.reference}</Link></td><td>{r.driverName}</td><td>{r.driverPhone ? <a href={`tel:${r.driverPhone}`}>{r.driverPhone}</a> : <span className="muted">not set</span>}</td><td>{r.hoursAway} h</td></tr>
            ))}
          </tbody></table></div>
        )}
      </div>
      <div className="panel">
        <h3>Recent activity</h3>
        {(activity.data ?? []).length === 0 && <p className="muted">No activity yet.</p>}
        <div className="tbl-wrap"><table className="tbl"><tbody>
          {((activity.data ?? []) as { id: string; action: string; created_at: string }[]).map((a) => (
            <tr key={a.id}><td style={{ whiteSpace: "nowrap" }}>{fmtDate(a.created_at, BUSINESS_TZ)}</td><td>{a.action}</td></tr>
          ))}
        </tbody></table></div>
      </div>
    </>
  );
}
