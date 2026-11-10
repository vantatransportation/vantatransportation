"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { fmtDate, postJson } from "./util";

export interface LogRow { id: string; channel: string; event: string; status: string; attempts: number; error: string | null; created_at: string; last_attempt_at: string | null }

export default function NotificationsTable({ rows, tz }: { rows: LogRow[]; tz: string }) {
  const router = useRouter();
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState("");
  const shown = rows.filter((r) => !filter || r.status === filter);

  async function retry(id: string) {
    setBusy(id);
    const { data } = await postJson("/api/admin/notifications/retry", { id });
    setBusy(null);
    setMsg(String(data.message ?? ""));
    router.refresh();
  }

  return (
    <div>
      <div className="toolbar">
        <select aria-label="Filter by status" value={filter} onChange={(e) => setFilter(e.target.value)}>
          <option value="">All</option><option value="failed">Failed</option><option value="skipped">Skipped (not configured)</option><option value="sent">Sent</option><option value="pending">Pending</option>
        </select>
        <span role="status" className="muted">{msg}</span>
      </div>
      <div className="tbl-wrap">
        <table className="tbl">
          <thead><tr><th>When</th><th>Channel</th><th>Event</th><th>Status</th><th>Attempts</th><th>Error</th><th /></tr></thead>
          <tbody>
            {shown.length === 0 && <tr><td colSpan={7} className="muted">No notifications.</td></tr>}
            {shown.map((r) => (
              <tr key={r.id}>
                <td>{fmtDate(r.created_at, tz)}</td><td>{r.channel}</td><td>{r.event}</td>
                <td><span className={`pill ${r.status === "sent" ? "pill--ok" : r.status === "failed" ? "pill--bad" : "pill--warn"}`}>{r.status}</span></td>
                <td>{r.attempts}</td><td style={{ maxWidth: 320 }}>{r.error}</td>
                <td>{r.status !== "sent" && <button className="btn btn--ghost btn-sm" disabled={busy === r.id} onClick={() => retry(r.id)}>{busy === r.id ? "Retrying…" : "Retry"}</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
