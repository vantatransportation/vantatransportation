import Link from "next/link";
import { notFound } from "next/navigation";
import FieldsForm from "@/components/admin/FieldsForm";
import NotesPanel, { type NoteRow } from "@/components/admin/NotesPanel";
import { fmtDate, fmtMoney, label } from "@/components/admin/util";
import { adminPage } from "@/lib/admin/data";
import { resources, toClient } from "@/lib/admin/resources";
import { BUSINESS_TZ } from "@/lib/config";

export const metadata = { title: "Customer" };
const UUID_RE = /^[0-9a-f-]{36}$/i;

export default async function CustomerDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID_RE.test(id)) notFound();
  const { db } = await adminPage();
  const { data: c } = await db.from("customers").select("*").eq("id", id).maybeSingle();
  if (!c) notFound();

  const [bookings, leads, quotes, followUps, notes] = await Promise.all([
    db.from("bookings").select("id,reference,status,pickup_at,pickup_address,dropoff_address,estimated_fare_cents,online_amount_cents,vehicles(name)").eq("customer_id", id).order("pickup_at", { ascending: false }),
    db.from("leads").select("id,subject,message,status,created_at").eq("customer_id", id).order("created_at", { ascending: false }),
    db.from("quote_requests").select("id,status,original_quote_cents,revised_price_cents,created_at").eq("customer_id", id).order("created_at", { ascending: false }),
    db.from("follow_ups").select("id,title,due_at,completed_at").eq("customer_id", id).order("due_at"),
    db.from("crm_notes").select("id,body,created_at").eq("entity_type", "customer").eq("entity_id", id).order("created_at", { ascending: false }),
  ]);
  type B = { id: string; reference: string; status: string; pickup_at: string; pickup_address: string; dropoff_address: string | null; estimated_fare_cents: number | null; online_amount_cents: number | null; vehicles: { name: string } | null };
  const bk = (bookings.data ?? []) as unknown as B[];
  const total = bk.filter((b) => b.status !== "cancelled").reduce((s, b) => s + (b.online_amount_cents ?? b.estimated_fare_cents ?? 0), 0);
  const now = Date.now();

  return (
    <>
      <p><Link href="/admin/customers" className="muted">← Customers</Link></p>
      <h1>{c.name}</h1>
      <p className="adm-sub">{[c.email, c.phone].filter(Boolean).join(" · ")} · Customer since {fmtDate(c.created_at, BUSINESS_TZ)}</p>
      <div className="cards">
        <div className="stat"><b>{bk.length}</b><span>Total bookings</span></div>
        <div className="stat"><b>{fmtMoney(total)}</b><span>Booking value (non-cancelled)</span></div>
        <div className="stat"><b>{(quotes.data ?? []).length}</b><span>Quote requests</span></div>
        <div className="stat"><b>{(leads.data ?? []).length}</b><span>Inquiries</span></div>
      </div>

      <div className="twocol">
        <div>
          <h2 style={{ marginTop: 0 }}>Details</h2>
          <FieldsForm resource={toClient(resources.customers)} id={id} initial={c} tz={BUSINESS_TZ} />
          <NotesPanel entityType="customer" entityId={id} notes={(notes.data ?? []) as NoteRow[]} tz={BUSINESS_TZ} />
        </div>
        <div>
          <h2 style={{ marginTop: 0 }}>Follow-ups</h2>
          <div className="panel">
            {(followUps.data ?? []).length === 0 && <p className="muted">None scheduled.</p>}
            {((followUps.data ?? []) as { id: string; title: string; due_at: string; completed_at: string | null }[]).map((f) => (
              <p key={f.id}>
                <span className={`pill ${f.completed_at ? "pill--ok" : new Date(f.due_at).getTime() < now ? "pill--bad" : "pill--warn"}`}>{f.completed_at ? "Done" : new Date(f.due_at).getTime() < now ? "Overdue" : "Open"}</span>{" "}
                {f.title} <span className="muted">· {fmtDate(f.due_at, BUSINESS_TZ)}</span>
              </p>
            ))}
            <p className="muted" style={{ marginTop: ".75rem" }}>Manage all follow-ups under <Link href="/admin/follow-ups" style={{ textDecoration: "underline" }}>Follow-ups</Link>.</p>
          </div>
          <h3 style={{ margin: "1rem 0 .5rem" }}>Add a follow-up</h3>
          <FieldsForm resource={toClient(resources["follow-ups"])} only={["title", "due_at", "notes"]} extra={{ customer_id: id }} tz={BUSINESS_TZ} submitLabel="Add follow-up" />
        </div>
      </div>

      <h2>Booking history</h2>
      <div className="tbl-wrap"><table className="tbl"><thead><tr><th>Ref</th><th>Pickup</th><th>Trip</th><th>Vehicle</th><th>Fare</th><th>Status</th></tr></thead><tbody>
        {bk.length === 0 && <tr><td colSpan={6} className="muted">No bookings.</td></tr>}
        {bk.map((b) => <tr key={b.id}><td><Link href={`/admin/bookings/${b.id}`} style={{ textDecoration: "underline" }}>{b.reference}</Link></td><td>{fmtDate(b.pickup_at, BUSINESS_TZ)}</td><td>{b.pickup_address} → {b.dropoff_address}</td><td>{b.vehicles?.name}</td><td>{fmtMoney(b.online_amount_cents ?? b.estimated_fare_cents)}</td><td>{label(b.status)}</td></tr>)}
      </tbody></table></div>

      <h2>Inquiries and quote requests</h2>
      <div className="tbl-wrap"><table className="tbl"><thead><tr><th>Type</th><th>Summary</th><th>Status</th><th>Received</th></tr></thead><tbody>
        {(leads.data ?? []).length + (quotes.data ?? []).length === 0 && <tr><td colSpan={4} className="muted">None.</td></tr>}
        {((leads.data ?? []) as { id: string; subject: string | null; message: string; status: string; created_at: string }[]).map((l) => <tr key={l.id}><td>Inquiry</td><td><Link href={`/admin/leads/${l.id}`} style={{ textDecoration: "underline" }}>{l.subject || l.message.slice(0, 60)}</Link></td><td>{label(l.status)}</td><td>{fmtDate(l.created_at, BUSINESS_TZ)}</td></tr>)}
        {((quotes.data ?? []) as { id: string; status: string; original_quote_cents: number | null; revised_price_cents: number | null; created_at: string }[]).map((q) => <tr key={q.id}><td>Quote request</td><td><Link href={`/admin/quotes/${q.id}`} style={{ textDecoration: "underline" }}>Original {fmtMoney(q.original_quote_cents) || "n/a"}{q.revised_price_cents != null ? `, revised ${fmtMoney(q.revised_price_cents)}` : ""}</Link></td><td>{label(q.status)}</td><td>{fmtDate(q.created_at, BUSINESS_TZ)}</td></tr>)}
      </tbody></table></div>
    </>
  );
}
