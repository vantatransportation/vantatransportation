"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { postJson } from "./util";

type TierChoice = { id: string; name: string };
export default function QuoteActions({ id, email, status, converted, hasRevised, vehicles, vehicleId: quotedVehicleId, quotedTierId, vehicleTiers = {} }: {
  id: string; email: string | null; status: string; converted: boolean; hasRevised: boolean; vehicles?: { id: string; name: string }[];
  /** The vehicle the customer chose (null when none), the tier they chose, and every vehicle's assigned tiers. */
  vehicleId?: string | null; quotedTierId?: string | null; vehicleTiers?: Record<string, TierChoice[]>;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const [vehicleId, setVehicleId] = useState("");
  const [tierId, setTierId] = useState(quotedTierId ?? "");
  const tierOptions = vehicleTiers[vehicleId || quotedVehicleId || ""] ?? [];
  // A tier is needed when the vehicle has several; a single-tier vehicle uses its only tier.
  const tierMissing = tierOptions.length > 1 && !tierOptions.some((t) => t.id === tierId);

  async function send() {
    if (!window.confirm("Send the revised price to the customer? This marks the discount as approved if it was still pending.")) return;
    setBusy("send");
    const { ok, data } = await postJson("/api/admin/quotes/send", { id });
    setBusy(null);
    if (!ok) return setMsg({ kind: "error", text: String(data.error ?? "Could not send.") });
    setLink(String(data.link));
    setMsg({ kind: "ok", text: `Revised quote published. ${String(data.emailStatus)}` });
    router.refresh();
  }

  async function convert() {
    if (!window.confirm("Create a booking from this accepted quote at the revised price?")) return;
    setBusy("convert");
    const { ok, data } = await postJson("/api/admin/quotes/convert", { id, vehicleId: vehicleId || undefined, tierId: tierOptions.length > 1 ? tierId || undefined : undefined });
    setBusy(null);
    if (!ok) return setMsg({ kind: "error", text: String(data.error ?? "Could not convert.") });
    router.push(`/admin/bookings/${String(data.bookingId)}`);
  }

  const mailto = link && email ? `mailto:${email}?subject=${encodeURIComponent("Your revised quote from Vanta Transportation")}&body=${encodeURIComponent(`Hello,\n\nWe have prepared a revised quote for your trip. You can review and respond here:\n${link}\n\nThank you,\nVanta Transportation`)}` : null;

  return (
    <div className="panel">
      <h3>Respond to the customer</h3>
      <p className="muted" style={{ marginBottom: "1rem" }}>
        Save the revised price above first. Sending publishes a private link where the customer can accept or decline. It is emailed to the customer through Brevo when email is configured; you can also copy the link or send it from your mail app.
      </p>
      <div className="actions" style={{ display: "flex", gap: ".75rem", flexWrap: "wrap" }}>
        <button className="btn btn--primary" onClick={send} disabled={busy !== null || converted || !hasRevised}>{busy === "send" ? "Sending…" : status === "revised_sent" ? "Resend revised quote" : "Send revised quote"}</button>
        <button className="btn btn--ghost" onClick={convert} disabled={busy !== null || converted || status !== "accepted" || tierMissing}>{converted ? "Already converted" : busy === "convert" ? "Converting…" : "Convert to booking"}</button>
      </div>
      {vehicles && vehicles.length > 0 && (
        <div className="field" style={{ marginTop: ".75rem" }}><label htmlFor="qa-vehicle">Vehicle for the booking (this request has none selected)</label>
          <select id="qa-vehicle" value={vehicleId} onChange={(e) => setVehicleId(e.target.value)}><option value="">Choose a vehicle</option>{vehicles.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}</select></div>
      )}
      {tierOptions.length > 1 && !converted && (
        <div className="field" style={{ marginTop: ".75rem" }}><label htmlFor="qa-tier">Service tier for the booking</label>
          <select id="qa-tier" value={tierId} onChange={(e) => setTierId(e.target.value)}><option value="">Choose a tier</option>{tierOptions.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select>
          <span className="help muted">This vehicle is offered in {tierOptions.length} tiers. {quotedTierId ? "The customer chose one in the calculator; you can change it." : "The customer did not choose one."}</span></div>
      )}
      {!hasRevised && <p className="muted" style={{ marginTop: ".75rem" }}>Enter a revised price to enable sending.</p>}
      {status !== "accepted" && !converted && <p className="muted" style={{ marginTop: ".5rem" }}>Converting becomes available once the status is Accepted (the customer accepts via the link, or you set it after agreeing by phone).</p>}
      {msg && <div className={`notice notice--${msg.kind}`} role="status">{msg.text}</div>}
      {link && (
        <div style={{ marginTop: "1rem" }}>
          <p className="muted">Private link for the customer:</p>
          <div className="linkbox">{link}</div>
          {mailto && <p style={{ marginTop: ".6rem" }}><a className="btn btn--ghost btn-sm" href={mailto}>Email it from my mail app</a></p>}
        </div>
      )}
    </div>
  );
}
