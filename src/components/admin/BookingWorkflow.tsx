"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { isoToLocalInput, localInputToIso, postJson } from "./util";

export interface DriverOption { id: string; name: string; plate: string | null; active: boolean }
interface Props {
  id: string; status: string; driverId: string | null; driverName: string | null; paymentReleased: boolean;
  /** Saved-card workflow facts (all recorded separately: card, admin approval, customer confirmation, verified payment). */
  checklist: { key: string; label: string; done: boolean; at: string | null; note?: string }[]; stageHeadline: string; cardFlow: boolean; cardSaved: boolean; paid: boolean;
  pickupAt: string; tz: string; nextSteps: string[]; confirmedAt: string | null; drivers: DriverOption[]; history: { to: string; at: string; note: string | null; actor: string }[];
}
const AWAITING = ["new_request", "pending_confirmation"];
const REASSIGNABLE = ["assigned", "getting_ready"];

/** Approve and assign, reassign, decline and cancel. Each action is a checked server operation; this component only calls them. */
export default function BookingWorkflow(p: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState("");
  const [msg, setMsg] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [driver, setDriver] = useState(p.drivers.find((d) => d.active && d.id !== p.driverId)?.id ?? "");
  const awaiting = AWAITING.includes(p.status);
  const canReassign = REASSIGNABLE.includes(p.status) && Boolean(p.driverId);
  const canAssignFirst = p.status === "confirmed" && !p.driverId && p.paid;
  const canCancel = !["completed", "cancelled", "rejected", "no_show", "picked_up"].includes(p.status);
  const canReschedule = !["picked_up", "in_progress", "completed", "cancelled", "rejected", "no_show"].includes(p.status);
  const [newTime, setNewTime] = useState(isoToLocalInput(p.pickupAt, p.tz));
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
      <h3>Review, approval and driver</h3>
      <p><strong>{p.stageHeadline}</strong></p>
      <ol className="checklist" aria-label="Booking and payment progress" style={{ margin: ".5rem 0 .75rem 1.1rem" }}>
        {p.checklist.map((c) => <li key={c.key}>{c.done ? "✓" : "○"} {c.label}{c.at ? ` · ${new Date(c.at).toLocaleString()}` : ""}{c.note ? ` · ${c.note}` : ""}</li>)}
      </ol>
      <p className="muted">
        {awaiting ? "Approving does NOT charge the customer, does NOT confirm the ride and assigns no driver. The customer then reviews the booking and confirms it themselves; only then is their saved card charged. The booking becomes Confirmed only after the payment provider verifies the payment, and only then can you assign a driver."
          : p.status === "approved" ? "Approved. Waiting for the customer to confirm and for the payment to be verified. You cannot assign a driver yet."
          : p.driverName ? `Assigned driver: ${p.driverName}.` : p.status === "confirmed" ? "Confirmed and paid. Assign a driver below." : "No driver assigned."}
      </p>
      {awaiting && p.cardFlow && !p.cardSaved && <p className="notice notice--error" role="status">The customer has not finished adding a card, so this booking cannot be approved yet. Nothing has been charged.</p>}
      {(awaiting || canAssignFirst || canReassign) && (
        <div className="form-grid" style={{ marginTop: ".75rem" }}>
          {(canAssignFirst || canReassign) && (
            <div className="field full">
              <label htmlFor="wf-driver">{canAssignFirst ? "Assign a driver" : "Reassign to"}</label>
              <select id="wf-driver" value={driver} onChange={(e) => setDriver(e.target.value)}>
                <option value="">Choose a driver…</option>
                {active.map((d) => <option key={d.id} value={d.id}>{d.name}{d.plate ? ` · ${d.plate}` : ""}</option>)}
              </select>
              {active.length === 0 && <span className="help muted">No active drivers. Add one under Drivers first.</span>}
            </div>
          )}
          <div className="full" style={{ display: "flex", gap: ".75rem", flexWrap: "wrap" }}>
            {awaiting && <button type="button" className="btn btn--primary" disabled={!!busy || (p.cardFlow && !p.cardSaved)} onClick={() => run("approve", {}, "Approve this booking? The customer is NOT charged and the ride is NOT confirmed. They will be asked to review and confirm, and only then is their saved card charged.")}>{busy === "approve" ? "Approving…" : "Approve booking"}</button>}
            {canAssignFirst && <button type="button" className="btn btn--primary" disabled={!driver || !!busy} onClick={() => run("assign", { driverId: driver }, "Assign this driver? The customer is emailed the driver's details.")}>{busy === "assign" ? "Assigning…" : "Assign driver"}</button>}
            {canReassign && <button type="button" className="btn btn--primary" disabled={!driver || !!busy} onClick={() => run("reassign", { driverId: driver }, "Reassign this ride? The current driver loses access immediately and everyone is notified.")}>{busy === "reassign" ? "Reassigning…" : "Reassign driver"}</button>}
            {awaiting && <button type="button" className="btn btn--ghost" disabled={!!busy} onClick={() => { const r = reason("Reason for declining (sent to the customer):"); if (r) run("reject", { reason: r }, "Decline this request and email the customer? Their card is not charged."); }}>Decline request</button>}
          </div>
        </div>
      )}
      {p.nextSteps.length > 0 && (
        <p style={{ marginTop: ".75rem", display: "flex", gap: ".5rem", flexWrap: "wrap", alignItems: "center" }}>
          <span className="muted">Move ride to:</span>
          {p.nextSteps.map((s) => <button key={s} type="button" className="btn btn--ghost btn-sm" disabled={!!busy} onClick={() => run("advance", { status: s }, `Set this ride to "${s.replace(/_/g, " ")}"? The customer's tracking page updates.`)}>{s.replace(/_/g, " ")}</button>)}
        </p>
      )}
      {canCancel && !awaiting && <p style={{ marginTop: ".75rem" }}><button type="button" className="btn btn--ghost" disabled={!!busy} onClick={() => { const r = reason("Reason for cancelling:"); if (r) run("cancel", { reason: r }, "Cancel this booking? The customer and driver are notified. Refunds are never issued automatically."); }}>Cancel booking</button></p>}
      {awaiting && <p style={{ marginTop: ".5rem" }}><button type="button" className="linkbtn" disabled={!!busy} onClick={() => { const r = reason("Reason for cancelling:"); if (r) run("cancel", { reason: r }, "Cancel this booking?"); }}>Cancel instead</button></p>}
      <div role="status" aria-live="polite">{msg && <div className={`notice ${msg.kind === "error" ? "notice--error" : ""}`} style={{ marginTop: ".75rem" }}>{msg.text}</div>}</div>
      {p.history.length > 0 && (
        <details style={{ marginTop: "1rem" }}><summary>Status history</summary>
          <table className="lines"><tbody>{p.history.map((h, i) => <tr key={i}><td>{new Date(h.at).toLocaleString()}</td><td>{h.to.replace(/_/g, " ")}{h.note ? ` · ${h.note}` : ""} <small className="muted">({h.actor})</small></td></tr>)}</tbody></table>
        </details>
      )}
      {canReschedule && (
        <div style={{ marginTop: "1rem" }}>
          <h4>Reschedule pickup</h4>
          <p className="muted">Times are in {p.tz}. Use this after a customer asks for a change in chat: the chat message alone never changes the booking. The customer and driver are emailed, and the 24-hour chat opening moves with the new time.</p>
          <div className="field"><label htmlFor="rs-time">New pickup time</label><input id="rs-time" type="datetime-local" value={newTime} onChange={(e) => setNewTime(e.target.value)} /></div>
          <p><button type="button" className="btn btn--ghost" disabled={!!busy || !newTime} onClick={() => { const r = reason("Reason or note (optional, shown in the booking history)") ; void run("reschedule", { pickupAt: localInputToIso(newTime, p.tz), reason: r }, "Change the official pickup time and email the customer and driver?"); }}>Apply new pickup time</button></p>
        </div>
      )}
    </div>
  );
}
