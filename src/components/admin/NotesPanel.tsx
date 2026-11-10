"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { fmtDate, postJson } from "./util";

export interface NoteRow { id: string; body: string; created_at: string }

export default function NotesPanel({ entityType, entityId, notes, tz }: { entityType: "customer" | "lead" | "booking" | "quote_request"; entityId: string; notes: NoteRow[]; tz: string }) {
  const router = useRouter();
  const [text, setText] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (busy || !text.trim()) return;
    setBusy(true);
    const { ok, data } = await postJson("/api/admin/notes", { entityType, entityId, body: text });
    setBusy(false);
    if (!ok) return setErr(String(data.error ?? "Could not save."));
    setErr("");
    setText("");
    router.refresh();
  }

  return (
    <div className="panel">
      <h3>Notes</h3>
      {notes.length === 0 && <p className="muted">No notes yet.</p>}
      {notes.map((n) => (
        <div key={n.id} className="note"><small>{fmtDate(n.created_at, tz)}</small>{n.body}</div>
      ))}
      <form onSubmit={add} style={{ display: "grid", gap: ".6rem", marginTop: "1rem" }}>
        <label htmlFor={`note-${entityId}`} className="muted">Add a note</label>
        <textarea id={`note-${entityId}`} value={text} onChange={(e) => setText(e.target.value)} rows={3} style={{ background: "var(--black)", color: "var(--white)", border: "1px solid var(--dark-grey)", padding: ".7rem", font: "inherit" }} />
        <div><button className="btn btn--primary btn-sm" disabled={busy}>{busy ? "Saving…" : "Add note"}</button> <span className="field__error">{err}</span></div>
      </form>
    </div>
  );
}
