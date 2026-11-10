"use client";

import { useMemo } from "react";
import { formatMoney } from "@/lib/pricing/engine";
import { useSessionString } from "@/lib/use-session";

interface Saved { reference: string; totalCents: number | null; currency: string; shownTotalCents: number | null; payUrl?: string | null }

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
  const changed = saved.totalCents != null && saved.shownTotalCents != null && saved.totalCents !== saved.shownTotalCents;
  return (
    <div className="notice" style={{ marginTop: "1.5rem" }}>
      {saved.totalCents != null ? <p>Estimated fare: <strong>{formatMoney(saved.totalCents, saved.currency)}</strong></p> : <p>We will confirm your price with you.</p>}
      {changed && <p className="muted" style={{ marginTop: ".5rem" }}>This differs from the estimate you saw ({formatMoney(saved.shownTotalCents!, saved.currency)}) because we recalculate the fare from current route and rate data when you submit.</p>}
      {saved.payUrl && (
        <p style={{ marginTop: "1rem" }}>
          <a className="btn btn--primary" href={saved.payUrl}>Pay online</a>
          <span className="muted" style={{ display: "block", marginTop: ".5rem" }}>Paying does not confirm your booking by itself. We confirm it with you directly. You can also pay later using the link in your email.</span>
        </p>
      )}
    </div>
  );
}
