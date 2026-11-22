"use client";

import { useEffect, useRef, useState } from "react";
import { parseInviteLink, type InviteLink } from "@/lib/driver/invite-link";

const STORE = "vanta-driver-invite";
let memory: InviteLink | null = null; // survives React's dev double-run and storage being blocked, for this page load only

type View =
  | { s: "loading" }
  | { s: "ready" }
  | { s: "error"; message: string; retry: boolean }
  | { s: "done"; signedIn: boolean };

function clearStored() {
  memory = null;
  try { sessionStorage.removeItem(STORE); } catch { /* storage unavailable */ }
}
/** Keeps what this page learned (a usable token, or why the link was rejected) for reloads and React's dev double-run. */
function remember(link: InviteLink) {
  memory = link;
  try { sessionStorage.setItem(STORE, JSON.stringify(link)); } catch { /* storage unavailable */ }
}
const rejected = (message: string): InviteLink => ({ kind: "error", code: "rejected", message });

/**
 * Reads the link Supabase redirected the browser to (token or error, in the #hash or ?query) exactly once, removes it from
 * the address bar, and keeps it for this tab only so that a reload does not lose a still-valid link.
 */
function captureLink(): InviteLink {
  const parsed = parseInviteLink(window.location.hash, window.location.search);
  if (parsed.kind !== "none") {
    remember(parsed);
    window.history.replaceState(null, "", window.location.pathname);
    return parsed;
  }
  if (memory) return memory;
  try {
    const v = JSON.parse(sessionStorage.getItem(STORE) ?? "null") as InviteLink | null;
    if (v?.kind === "session" && typeof v.accessToken === "string") return v;
    if (v?.kind === "error" && typeof v.message === "string") return v;
  } catch { /* nothing stored */ }
  return { kind: "none" };
}

const post = async (payload: Record<string, unknown>) => {
  const res = await fetch("/api/driver/set-password", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  const data = (await res.json().catch(() => ({}))) as { error?: string; signedIn?: boolean };
  return { res, data };
};
const transient = (status: number) => status === 429 || status >= 500;

export default function SetPassword() {
  const [view, setView] = useState<View>({ s: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState(""); const [busy, setBusy] = useState(false);
  const token = useRef<string | null>(null);

  useEffect(() => {
    let alive = true;
    const show = (v: View) => { if (alive) setView(v); };
    (async () => {
      const link = captureLink();
      if (link.kind === "error") return show({ s: "error", message: link.message, retry: false });
      if (link.kind === "none") return show({ s: "error", message: "This page opens from the link in your invitation email. Open that email and tap the invitation button.", retry: false });
      token.current = link.accessToken;
      try {
        const { res, data } = await post({ accessToken: link.accessToken, check: true });
        if (res.ok) return show({ s: "ready" });
        if (transient(res.status)) return show({ s: "error", message: data.error ?? "Something went wrong on our side. Please try again.", retry: true });
        const message = data.error ?? "This invitation link is not valid.";
        remember(rejected(message));
        show({ s: "error", message, retry: false });
      } catch {
        show({ s: "error", message: "Could not reach the server. Check your connection and try again.", retry: true });
      }
    })();
    return () => { alive = false; };
  }, [attempt]);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault(); if (busy || !token.current) return;
    const fd = new FormData(e.currentTarget); const pw = String(fd.get("password") ?? "");
    if (pw !== String(fd.get("confirm") ?? "")) return setError("The two passwords do not match.");
    setBusy(true); setError("");
    try {
      const { res, data } = await post({ accessToken: token.current, password: pw });
      if (res.ok) {
        clearStored();
        setView({ s: "done", signedIn: data.signedIn === true });
        if (data.signedIn) window.location.assign("/driver");
        return;
      }
      if (!transient(res.status) && res.status !== 422) {
        const message = data.error ?? "This invitation link is not valid.";
        remember(rejected(message));
        setView({ s: "error", message, retry: false });
        return;
      }
      setError(data.error ?? "Could not set the password."); setBusy(false);
    } catch { setError("Could not reach the server. Check your connection and try again."); setBusy(false); }
  }

  if (view.s === "loading") return <p className="muted" role="status">Checking your invitation…</p>;
  if (view.s === "done") {
    return (
      <div className="notice notice--ok" role="status">
        <p>Your password is set.</p>
        <p style={{ marginTop: ".75rem" }}>
          {view.signedIn ? <>Taking you to your rides… <a href="/driver">Continue</a></> : <a className="btn btn--primary" href="/driver/login">Sign in</a>}
        </p>
      </div>
    );
  }
  if (view.s === "error") {
    return (
      <div className="notice notice--error" role="alert">
        <p><strong>We could not open your invitation.</strong></p>
        <p style={{ marginTop: ".5rem" }}>{view.message}</p>
        {!view.retry && <p style={{ marginTop: ".5rem" }}>Ask Vanta to send you a new invitation, then open the newest email. If you have already set your password, <a href="/driver/login">sign in here</a>.</p>}
        {view.retry && <p style={{ marginTop: ".75rem" }}><button type="button" className="btn btn--ghost" onClick={() => { setView({ s: "loading" }); setAttempt((n) => n + 1); }}>Try again</button></p>}
      </div>
    );
  }
  return (
    <form onSubmit={submit} className="form-grid" aria-label="Set password">
      <div className="field full"><label htmlFor="n-pw">New password (at least 10 characters)</label><input id="n-pw" name="password" type="password" autoComplete="new-password" minLength={10} required /></div>
      <div className="field full"><label htmlFor="n-pw2">Confirm password</label><input id="n-pw2" name="confirm" type="password" autoComplete="new-password" minLength={10} required /></div>
      <div className="full"><button className="btn btn--primary" type="submit" disabled={busy} style={{ minHeight: 48, width: "100%" }}>{busy ? "Saving…" : "Save password"}</button></div>
      <div role="alert" aria-live="polite" className="full">{error && <div className="notice notice--error">{error}</div>}</div>
    </form>
  );
}
