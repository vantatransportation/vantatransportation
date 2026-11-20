"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { postJson } from "./util";

export interface DriverOption { id: string; name: string; plate: string | null; active: boolean }
interface Props {
  id: string; status: string; driverId: string | null; driverName: string | null; paymentReleased: boolean;
  drivers: DriverOption[]; history: { to: string; at: string; note: string | null; actor: string }[];
}
const AWAITING = ["new_request", "pending_confirmation"];
const REASSIGNABLE = ["confirmed", "assigned", "getting_ready"];

/** Approve and assign, reassign, decline and cancel. Each action is a checked server operation; this component only calls them. */
export default function BookingWorkflow(p: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState("");
  const [msg, setMsg] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [driver, setDriver] = useState(p.drivers.find((d) => d.active && d.id !== p.driverId)?.id ?? "");
  const awaiting = AWAITING.includes(p.status);
  const canReassign = REASSIGNABLE.includes(p.status) && Boolean(p.driverId);
  const canCancel = !["completed", "cancelled", "rejected", "no_show", "picked_up"].includes(p.status);
  const active = p.drivers.filter((d) => d.active && d.id !== p.driverId);

  async function run(action: string, extra: Record<string, unknown>, confirmText: string) {
    if (busy || !window.confirm(confirmText)) return;
    setBusy(action); setMsg(null);
    const { ok, data } = await postJson("/api/admin/bookings/workflow", { id: p.id, action, ...extra });
    setBusy("");
    if (!ok) return setMsg({ kind: "error", text: (data as { error?: string }).error ?? "That did not work. Please try again." });
    const refund = (data as { refundReviewNeeded?: boolean }).refundReviewNeeded;
    setMsg({ kind: "ok", text: refund ? "Cancelled. A payment was received: review whether a refund applies and issue it in Stripe or PayPal yourself. Nothing was refunded automatically." : "Done." });
    router.refresh();
  }
  const reason = (label: string) => window.prompt(label)?.trim() ?? "";

  return (
    <div className="panel">
      <h3>Review and driver</h3>
      <p className="muted">
        {awaiting ? "This request is awaiting review. The customer has not been charged and has no payment link. Approving assigns a driver and releases the payment link to the customer."
          : p.driverName ? `Assigned driver: ${p.driverName}. Payment link ${p.paymentReleased ? "released to the customer" : "not released"}.` : "No driver assigned."}
      </p>
      {(awaiting || canReassign) && (
        <div className="form-grid" style={{ marginTop: ".75rem" }}>
          <div className="field full">
            <label htmlFor="wf-driver">{awaiting ? "Assign a driver" : "Reassign to"}</label>
            <select id="wf-driver" value={driver} onChange={(e) => setDriver(e.target.value)}>
              <option value="">Choose a driver…</option>
              {active.map((d) => <option key={d.id} value={d.id}>{d.name}{d.plate ? ` · ${d.plate}` : ""}</option>)}
            </select>
            {active.length === 0 && <span className="help muted">No active drivers. Add one under Drivers first.</span>}
          </div>
          <div className="full" style={{ display: "flex", gap: ".75rem", flexWrap: "wrap" }}>
            {awaiting && <button type="button" className="btn btn--primary" disabled={!driver || !!busy} onClick={() => run("approve_assign", { driverId: driver }, "Approve this booking, assign the driver and email the customer their payment link?")}>{busy === "approve_assign" ? "Approving…" : "Approve & assign driver"}</button>}
            {canReassign && <button type="button" className="btn btn--primary" disabled={!driver || !!busy} onClick={() => run("reassign", { driverId: driver }, "Reassign this ride? The current driver loses access immediately and everyone is notified.")}>{busy === "reassign" ? "Reassigning…" : "Reassign driver"}</button>}
            {awaiting && <button type="button" className="btn btn--ghost" disabled={!!busy} onClick={() => { const r = reason("Reason for declining (sent to the customer):"); if (r) run("reject", { reason: r }, "Decline this request and email the customer?"); }}>Decline request</button>}
          </div>
        </div>
      )}
      {canCancel && !awaiting && <p style={{ marginTop: ".75rem" }}><button type="button" className="btn btn--ghost" disabled={!!busy} onClick={() => { const r = reason("Reason for cancelling:"); if (r) run("cancel", { reason: r }, "Cancel this booking? The customer and driver are notified. Refunds are never issued automatically."); }}>Cancel booking</button></p>}
      {awaiting && <p style={{ marginTop: ".5rem" }}><button type="button" className="linkbtn" disabled={!!busy} onClick={() => { const r = reason("Reason for cancelling:"); if (r) run("cancel", { reason: r }, "Cancel this booking?"); }}>Cancel instead</button></p>}
      <div role="status" aria-live="polite">{msg && <div className={`notice ${msg.kind === "error" ? "notice--error" : ""}`} style={{ marginTop: ".75rem" }}>{msg.text}</div>}</div>
      {p.history.length > 0 && (
        <details style={{ marginTop: "1rem" }}><summary>Status history</summary>
          <table className="lines"><tbody>{p.history.map((h, i) => <tr key={i}><td>{new Date(h.at).toLocaleString()}</td><td>{h.to.replace(/_/g, " ")}{h.note ? ` · ${h.note}` : ""} <small className="muted">({h.actor})</small></td></tr>)}</tbody></table>
        </details>
      )}
    </div>
  );
}
