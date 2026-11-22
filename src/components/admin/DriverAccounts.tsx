"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { postJson } from "./util";

interface D { id: string; name: string; email: string; active: boolean; hasAccount: boolean }

/** Sends each driver a sign-in invitation. Drivers set their own password; nobody (including admins) ever sees it. */
export default function DriverAccounts({ drivers }: { drivers: D[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState("");
  const [msg, setMsg] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const pending = drivers.filter((d) => d.active && !d.hasAccount);
  const withAccount = drivers.filter((d) => d.active && d.hasAccount);
  if (!drivers.length) return null;

  async function invite(d: D, again = false) {
    const question = again ? `Email ${d.email} a new link to set their password and sign in? Older links stop working once the newest one is used.` : `Email a sign-in invitation to ${d.email}?`;
    if (busy || !window.confirm(question)) return;
    setBusy(d.id); setMsg(null);
    const { ok, data } = await postJson("/api/admin/drivers/invite", { driverId: d.id });
    setBusy("");
    const r = data as { error?: string; sentTo?: string; opensAt?: string };
    setMsg(ok ? { kind: "ok", text: `${again ? "New link" : "Invitation"} sent to ${r.sentTo ?? d.email}. The link opens ${r.opensAt ?? "the driver set-password page"}.` } : { kind: "error", text: r.error ?? "Could not send the invitation." });
    if (ok) router.refresh();
  }
  return (
    <div className="panel">
      <h3>Driver sign-in accounts</h3>
      {pending.length === 0 ? <p className="muted">Every active driver has a sign-in account.</p> : (
        <ul style={{ listStyle: "none", padding: 0, display: "grid", gap: ".5rem" }}>
          {pending.map((d) => (
            <li key={d.id} style={{ display: "flex", gap: ".75rem", alignItems: "center", flexWrap: "wrap" }}>
              <span>{d.name} <span className="muted">({d.email})</span></span>
              <button type="button" className="btn btn--ghost" disabled={!!busy} onClick={() => invite(d)}>{busy === d.id ? "Sending…" : "Send sign-in invitation"}</button>
            </li>
          ))}
        </ul>
      )}
      {withAccount.length > 0 && (
        <>
          <p className="muted" style={{ marginTop: ".75rem" }}>Link expired, or a driver forgot their password? Send a new link:</p>
          <ul style={{ listStyle: "none", padding: 0, display: "grid", gap: ".5rem", marginTop: ".5rem" }}>
            {withAccount.map((d) => (
              <li key={d.id} style={{ display: "flex", gap: ".75rem", alignItems: "center", flexWrap: "wrap" }}>
                <span>{d.name} <span className="muted">({d.email})</span></span>
                <button type="button" className="btn btn--ghost" disabled={!!busy} onClick={() => invite(d, true)}>{busy === d.id ? "Sending…" : "Send new link"}</button>
              </li>
            ))}
          </ul>
        </>
      )}
      <p className="muted" style={{ marginTop: ".5rem" }}>Drivers sign in at <strong>/driver</strong>. Deactivating a driver removes their access immediately.</p>
      <div role="status" aria-live="polite">{msg && <div className={`notice ${msg.kind === "error" ? "notice--error" : ""}`} style={{ marginTop: ".5rem" }}>{msg.text}</div>}</div>
    </div>
  );
}
