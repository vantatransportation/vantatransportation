"use client";

import { useEffect, useState } from "react";

/** Reads the one-time token Supabase puts in the invitation link's #hash, then removes it from the address bar. */
export default function SetPassword() {
  const [token, setToken] = useState<string | null | undefined>(undefined);
  const [error, setError] = useState(""); const [busy, setBusy] = useState(false); const [done, setDone] = useState(false);
  useEffect(() => {
    const p = new URLSearchParams(window.location.hash.replace(/^#/, ""));
    const t = p.get("access_token");
    Promise.resolve().then(() => setToken(t)); // the hash only exists in the browser, so it is read after mount
    if (window.location.hash) history.replaceState(null, "", window.location.pathname);
  }, []);
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault(); if (busy || !token) return;
    const fd = new FormData(e.currentTarget); const pw = String(fd.get("password") ?? "");
    if (pw !== String(fd.get("confirm") ?? "")) return setError("The two passwords do not match.");
    setBusy(true); setError("");
    try {
      const res = await fetch("/api/driver/set-password", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ accessToken: token, password: pw }) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setError(data.error ?? "Could not set the password."); setBusy(false); return; }
      setDone(true);
    } catch { setError("Could not reach the server."); setBusy(false); }
  }
  if (token === undefined) return <p className="muted">Loading…</p>;
  if (done) return <div className="notice"><p>Your password is set.</p><p style={{ marginTop: ".75rem" }}><a className="btn btn--primary" href="/driver/login">Sign in</a></p></div>;
  if (!token) return <div className="notice notice--error">This invitation link is not valid or has expired. Ask Vanta to send a new one.</div>;
  return (
    <form onSubmit={submit} className="form-grid" aria-label="Set password">
      <div className="field full"><label htmlFor="n-pw">New password (at least 10 characters)</label><input id="n-pw" name="password" type="password" autoComplete="new-password" minLength={10} required /></div>
      <div className="field full"><label htmlFor="n-pw2">Confirm password</label><input id="n-pw2" name="confirm" type="password" autoComplete="new-password" minLength={10} required /></div>
      <div className="full"><button className="btn btn--primary" type="submit" disabled={busy} style={{ minHeight: 48, width: "100%" }}>{busy ? "Saving…" : "Save password"}</button></div>
      <div role="alert" aria-live="polite" className="full">{error && <div className="notice notice--error">{error}</div>}</div>
    </form>
  );
}
