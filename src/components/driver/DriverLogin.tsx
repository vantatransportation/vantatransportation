"use client";

import { useState } from "react";

export default function DriverLogin() {
  const [error, setError] = useState(""); const [busy, setBusy] = useState(false);
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault(); if (busy) return;
    const fd = new FormData(e.currentTarget); setBusy(true); setError("");
    try {
      const res = await fetch("/api/driver/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: fd.get("email"), password: fd.get("password") }) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setError(data.error ?? "Could not sign in."); setBusy(false); return; }
      window.location.assign("/driver");
    } catch { setError("Could not reach the server. Check your connection."); setBusy(false); }
  }
  return (
    <form onSubmit={submit} className="form-grid" aria-label="Driver sign in">
      <div className="field full"><label htmlFor="d-email">Email</label><input id="d-email" name="email" type="email" autoComplete="username" required /></div>
      <div className="field full"><label htmlFor="d-pw">Password</label><input id="d-pw" name="password" type="password" autoComplete="current-password" required /></div>
      <div className="full"><button className="btn btn--primary" type="submit" disabled={busy} style={{ minHeight: 48, width: "100%" }}>{busy ? "Signing in…" : "Sign in"}</button></div>
      <div role="alert" aria-live="polite" className="full">{error && <div className="notice notice--error">{error}</div>}</div>
    </form>
  );
}
