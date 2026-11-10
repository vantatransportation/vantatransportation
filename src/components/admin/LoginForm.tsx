"use client";

import { useState } from "react";
import { postJson } from "./util";

export default function LoginForm() {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    const fd = new FormData(e.currentTarget);
    const { ok, data } = await postJson("/api/admin/login", { email: fd.get("email"), password: fd.get("password") });
    if (ok) {
      window.location.assign("/admin");
      return;
    }
    setError(String(data.error ?? "Could not sign in."));
    setBusy(false);
  }

  return (
    <form onSubmit={submit} style={{ display: "grid", gap: "1rem" }}>
      <div className="field"><label htmlFor="email">Email</label><input id="email" name="email" type="email" autoComplete="username" required /></div>
      <div className="field"><label htmlFor="password">Password</label><input id="password" name="password" type="password" autoComplete="current-password" required /></div>
      <button className="btn btn--primary" disabled={busy}>{busy ? "Signing in…" : "Sign in"}</button>
      <div role="alert" className="field__error">{error}</div>
    </form>
  );
}
