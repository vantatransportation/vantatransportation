"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { postJson } from "./util";

interface Props {
  id: string;
  status: string;
  fulfilmentMode: string;
  partnerName: string | null;
  hasMeetGreet: boolean;
  meetGreetStatus: string | null;
  waitingIncluded: number;
  waitingRateApproved: boolean;
}
const PAY = ["none", "pending", "invoiced", "paid", "waived"];

export default function BookingOps(p: Props) {
  const router = useRouter();
  const [msg, setMsg] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState("");

  async function run(action: string, e: React.FormEvent<HTMLFormElement>, confirmText?: string) {
    e.preventDefault();
    if (confirmText && !window.confirm(confirmText)) return;
    const fd = Object.fromEntries(new FormData(e.currentTarget).entries());
    setBusy(action); setMsg(null);
    const { ok, data } = await postJson("/api/admin/bookings/ops", { id: p.id, action, ...fd });
    setBusy("");
    setMsg(ok ? { kind: "ok", text: "Saved." } : { kind: "error", text: String(data.error ?? "Could not save.") });
    if (ok) router.refresh();
  }

  return (
    <div className="panel">
      <h3>Operations</h3>
      <p className="muted">These record amounts and statuses only. Nothing here charges a payment method.</p>
      <div role="status" aria-live="polite">{msg && <div className={`notice notice--${msg.kind}`}>{msg.text}</div>}</div>

      <form onSubmit={(e) => run("fulfilment", e)} className="form-grid" aria-label="Fulfilment">
        <h4 className="full">Fulfilment</h4>
        <div className="field"><label htmlFor="f-mode">Who is fulfilling this trip</label>
          <select id="f-mode" name="mode" defaultValue={p.fulfilmentMode}><option value="review">Needs staff review</option><option value="vanta">Vanta</option><option value="partner">Approved partner / affiliate</option></select></div>
        <div className="field"><label htmlFor="f-partner">Partner name (if any)</label><input id="f-partner" name="partnerName" defaultValue={p.partnerName ?? ""} /></div>
        <div className="full"><button className="btn btn--ghost btn-sm" disabled={busy === "fulfilment"}>Save fulfilment</button></div>
      </form>

      {p.hasMeetGreet && (
        <form onSubmit={(e) => run("meet_greet", e)} className="form-grid" aria-label="Meet and Greet">
          <h4 className="full">Airport Meet &amp; Greet</h4>
          <div className="field"><label htmlFor="mg-status">Status</label>
            <select id="mg-status" name="status" defaultValue={p.meetGreetStatus ?? "requested"}><option value="requested">Requested (not confirmed)</option><option value="confirmed">Confirmed by Vanta</option><option value="declined">Declined</option></select></div>
          <div className="field"><label htmlFor="mg-charge">Approved charge ($, optional)</label><input id="mg-charge" name="chargeDollars" type="number" min={0} step="0.01" /></div>
          <div className="full"><button className="btn btn--ghost btn-sm" disabled={busy === "meet_greet"}>Save Meet &amp; Greet</button></div>
        </form>
      )}

      <form onSubmit={(e) => run("waiting", e)} className="form-grid" aria-label="Waiting time">
        <h4 className="full">Waiting time</h4>
        <div className="field"><label htmlFor="w-min">Minutes the driver waited</label><input id="w-min" name="minutesWaited" type="number" min={0} required /><span className="help muted">{p.waitingIncluded} minutes are included.{p.waitingRateApproved ? "" : " No waiting rate is approved yet, so enter any charge manually."}</span></div>
        <div className="field"><label htmlFor="w-charge">Charge override ($, optional)</label><input id="w-charge" name="chargeDollars" type="number" min={0} step="0.01" /></div>
        <div className="field"><label htmlFor="w-pay">Payment status</label><select id="w-pay" name="chargeStatus" defaultValue="">{[""].concat(PAY).map((s) => <option key={s} value={s}>{s || "Automatic"}</option>)}</select></div>
        <div className="full"><button className="btn btn--ghost btn-sm" disabled={busy === "waiting"}>Record waiting time</button></div>
      </form>

      {p.status !== "no_show" && (
        <form onSubmit={(e) => run("no_show", e, "Mark this booking as a no-show? The customer will be emailed.")} className="form-grid" aria-label="No-show">
          <h4 className="full">Mark as no-show</h4>
          <div className="field full"><label htmlFor="n-reason">Reason (required)</label><textarea id="n-reason" name="reason" required /></div>
          <div className="field"><label htmlFor="n-charge">Charge ($, optional)</label><input id="n-charge" name="chargeDollars" type="number" min={0} step="0.01" /></div>
          <div className="field"><label htmlFor="n-pay">Payment status</label><select id="n-pay" name="chargeStatus" defaultValue="none">{PAY.map((s) => <option key={s}>{s}</option>)}</select></div>
          <div className="full"><button className="btn btn--ghost btn-sm" disabled={busy === "no_show"}>Mark as no-show</button></div>
        </form>
      )}
    </div>
  );
}
