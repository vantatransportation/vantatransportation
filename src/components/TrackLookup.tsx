"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import TripStatus from "@/components/TripStatus";
import { normalizeTrackingCode } from "@/lib/tracking";
import type { TripView } from "@/lib/trip";

type View =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "found"; code: string; trip: TripView }
  | { kind: "error"; message: string };

/**
 * Public tracking form. The tracking ID is sent in a POST body (never a URL). Email links carry it in the #fragment, which browsers
 * do not send to servers or in Referer headers; it is read once and removed from the address bar.
 */
export default function TrackLookup({ tz }: { tz: string }) {
  const [input, setInput] = useState("");
  const [view, setView] = useState<View>({ kind: "idle" });
  const [fieldError, setFieldError] = useState("");
  const result = useRef<HTMLDivElement>(null);
  const busy = useRef(false);

  const lookup = useCallback(async (raw: string) => {
    if (busy.current) return;
    setFieldError("");
    const code = normalizeTrackingCode(raw);
    if (!code) {
      setView({ kind: "idle" });
      setFieldError(/^\s*VT-?\d+\s*$/i.test(raw) ? "That looks like a booking reference. Tracking needs the tracking ID, which starts with TRK- and is in your confirmation email." : "Enter your tracking ID, for example TRK-7Q2MK-9XH4D-B6TWA.");
      return;
    }
    busy.current = true;
    setView({ kind: "loading" });
    try {
      const res = await fetch("/api/track", { method: "POST", cache: "no-store", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ trackingId: code }) });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.trip) setView({ kind: "found", code, trip: data.trip as TripView });
      else if (res.status === 404) setView({ kind: "error", message: "We could not find a booking for that tracking ID. Check it against your confirmation email and try again." });
      else if (res.status === 429) setView({ kind: "error", message: data.error ?? "Too many attempts. Please wait a few minutes and try again." });
      else setView({ kind: "error", message: "Tracking is temporarily unavailable. Please try again in a moment." });
    } catch {
      setView({ kind: "error", message: "We could not reach the server. Check your connection and try again." });
    }
    busy.current = false;
  }, []);

  useEffect(() => {
    const m = /^#id=([^&]+)/.exec(window.location.hash);
    if (!m) return;
    let id = "";
    try { id = decodeURIComponent(m[1]); } catch { return; }
    history.replaceState(null, "", window.location.pathname); // keep the ID out of the address bar, history and bookmarks
    setInput(id);
    void lookup(id);
  }, [lookup]);

  useEffect(() => { if (view.kind === "found" || view.kind === "error") result.current?.focus(); }, [view.kind]);

  return (
    <>
      <form onSubmit={(e) => { e.preventDefault(); void lookup(input); }} noValidate aria-label="Track your ride">
        <div className="field">
          <label htmlFor="track-id">Tracking ID</label>
          <input id="track-id" name="trackingId" value={input} onChange={(e) => setInput(e.target.value)} autoComplete="off" autoCapitalize="characters" spellCheck={false} inputMode="text" maxLength={40}
            placeholder="TRK-XXXXX-XXXXX-XXXXX" aria-invalid={fieldError ? true : undefined} aria-describedby={fieldError ? "track-err" : "track-help"} />
          <span id="track-help" className="help muted">You will find it in your booking request and confirmation emails. It is different from your booking reference.</span>
          {fieldError && <span id="track-err" className="field__error" role="alert">{fieldError}</span>}
        </div>
        <button className="btn btn--primary" style={{ marginTop: "1rem", minHeight: 48 }} disabled={view.kind === "loading"}>{view.kind === "loading" ? "Checking…" : "Track"}</button>
      </form>

      <div ref={result} tabIndex={-1} aria-live="polite" style={{ marginTop: "2rem", outline: "none" }}>
        {view.kind === "loading" && <p className="muted" role="status">Looking up your ride…</p>}
        {view.kind === "error" && <div className="notice notice--error" role="alert">{view.message}</div>}
        {view.kind === "found" && <TripStatus credential={{ kind: "code", code: view.code }} initial={view.trip} tz={tz} />}
      </div>
    </>
  );
}
