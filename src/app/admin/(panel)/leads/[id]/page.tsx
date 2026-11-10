import Link from "next/link";
import { notFound } from "next/navigation";
import FieldsForm from "@/components/admin/FieldsForm";
import NotesPanel, { type NoteRow } from "@/components/admin/NotesPanel";
import { fmtDate } from "@/components/admin/util";
import { adminPage } from "@/lib/admin/data";
import { resources, toClient } from "@/lib/admin/resources";
import { BUSINESS_TZ } from "@/lib/config";

export const metadata = { title: "Lead" };
const UUID_RE = /^[0-9a-f-]{36}$/i;

export default async function LeadDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID_RE.test(id)) notFound();
  const { db } = await adminPage();
  const { data: l } = await db.from("leads").select("*").eq("id", id).maybeSingle();
  if (!l) notFound();
  const notes = await db.from("crm_notes").select("id,body,created_at").eq("entity_type", "lead").eq("entity_id", id).order("created_at", { ascending: false });

  return (
    <>
      <p><Link href="/admin/leads" className="muted">← Leads</Link></p>
      <h1>{l.subject || "Inquiry"}</h1>
      <p className="adm-sub">From {l.name} · {fmtDate(l.created_at, BUSINESS_TZ)} · Source: {l.source}</p>
      <div className="twocol">
        <div className="panel">
          <h3>Message</h3>
          <dl className="kv"><dt>Email</dt><dd>{l.email && <a href={`mailto:${l.email}`}>{l.email}</a>}</dd><dt>Phone</dt><dd>{l.phone && <a href={`tel:${l.phone}`}>{l.phone}</a>}</dd>
            {l.customer_id && <><dt>Customer</dt><dd><Link href={`/admin/customers/${l.customer_id}`} style={{ textDecoration: "underline" }}>Open customer record</Link></dd></>}</dl>
          <p style={{ marginTop: "1rem", whiteSpace: "pre-wrap" }}>{l.message}</p>
        </div>
        <div>
          <FieldsForm resource={toClient(resources.leads)} id={id} initial={l} tz={BUSINESS_TZ} submitLabel="Update status" />
          {l.customer_id && (
            <>
              <h3 style={{ margin: "1rem 0 .5rem" }}>Add a follow-up</h3>
              <FieldsForm resource={toClient(resources["follow-ups"])} only={["title", "due_at", "notes"]} extra={{ customer_id: l.customer_id }} tz={BUSINESS_TZ} submitLabel="Add follow-up" />
            </>
          )}
        </div>
      </div>
      <NotesPanel entityType="lead" entityId={id} notes={(notes.data ?? []) as NoteRow[]} tz={BUSINESS_TZ} />
    </>
  );
}
