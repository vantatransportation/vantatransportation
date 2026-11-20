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
  if (!drivers.length) return null;

  async function invite(d: D) {
    if (busy || !window.confirm(`Email a sign-in invitation to ${d.email}?`)) return;
    setBusy(d.id); setMsg(null);
    const { ok, data } = await postJson("/api/admin/drivers/invite", { driverId: d.id });
    setBusy("");
    setMsg(ok ? { kind: "ok", text: `Invitation sent to ${d.email}.` } : { kind: "error", text: (data as { error?: string }).error ?? "Could not send the invitation." });
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
      <p className="muted" style={{ marginTop: ".5rem" }}>Drivers sign in at <strong>/driver</strong>. Deactivating a driver removes their access immediately.</p>
      <div role="status" aria-live="polite">{msg && <div className={`notice ${msg.kind === "error" ? "notice--error" : ""}`} style={{ marginTop: ".5rem" }}>{msg.text}</div>}</div>
    </div>
  );
}
