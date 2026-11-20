"use client";

import { useMemo } from "react";
import { formatMoney } from "@/lib/pricing/engine";
import { useSessionString } from "@/lib/use-session";

interface Saved { reference: string; totalCents: number | null; onlineAmountCents?: number | null; currency: string; shownTotalCents: number | null; payUrl?: string | null; tripUrl?: string | null }

export default function ConfirmationDetails({ reference }: { reference: string }) {
  const raw = useSessionString("vanta:confirmation");
  const saved = useMemo<Saved | null>(() => {
    try {
      const s = raw ? (JSON.parse(raw) as Saved) : null;
      return s && s.reference === reference ? s : null;
    } catch {
      return null;
    }
  }, [raw, reference]);
  if (!saved) return null;
  // The saved online amount is what the server calculated; compare it with what the customer saw.
  const online = saved.onlineAmountCents ?? null;
  const changed = online != null && saved.shownTotalCents != null && online !== saved.shownTotalCents;
  return (
    <div className="notice" style={{ marginTop: "1.5rem" }}>
      {online != null ? <p>Amount due online: <strong>{formatMoney(online, saved.currency)}</strong> <span className="muted">(fixed tier price plus any add-ons)</span></p> : <p>We will confirm your price with you.</p>}
      {saved.totalCents != null && <p className="muted" style={{ marginTop: ".5rem" }}>Estimated trip fare: {formatMoney(saved.totalCents, saved.currency)}. For information only: it is not part of the online amount.</p>}
      {changed && <p className="muted" style={{ marginTop: ".5rem" }}>The online amount differs from the one you saw ({formatMoney(saved.shownTotalCents!, saved.currency)}) because the tier prices were updated. The amount shown here is the one we recorded.</p>}
      <p className="muted" style={{ marginTop: ".5rem" }}>You have not been charged. This is a request awaiting review: we will email you once it is approved and a driver is assigned, with a secure link to pay.</p>
      {saved.tripUrl && <p style={{ marginTop: ".75rem" }}><a className="btn btn--ghost" href={saved.tripUrl}>View your booking status</a><span className="muted" style={{ display: "block", marginTop: ".5rem" }}>Bookmark this private page: it shows approval, your driver and chat once a driver is assigned. Anyone with the link can open it, so do not share it.</span></p>}
      {saved.payUrl && (
        <p style={{ marginTop: "1rem" }}>
          <a className="btn btn--primary" href={saved.payUrl}>Pay online</a>
          <span className="muted" style={{ display: "block", marginTop: ".5rem" }}>Paying does not confirm your booking by itself. We confirm it with you directly. You can also pay later using the link in your email.</span>
        </p>
      )}
    </div>
  );
}
