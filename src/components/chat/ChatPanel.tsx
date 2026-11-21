"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { MAX_MESSAGE, QUICK_REPLIES, type ChatMessage, type ChatRole } from "@/lib/chat";

interface Props {
  role: ChatRole;
  /** GET returns {messages, open}; POST sends {body, clientId, bookingId?}. */
  endpoint: string;
  /** Driver chats are per ride; customers are scoped by their private link instead. */
  bookingId?: string;
  /** Poll interval in ms while the tab is visible. Chat uses polling because customers have no Supabase session for Realtime. */
  intervalMs?: number;
  title?: string;
  /** Extra request headers (the customer chat sends the tracking ID this way so it never appears in a URL). */
  headers?: Record<string, string>;
}
const fmt = (iso: string) => new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit", month: "short", day: "numeric" }).format(new Date(iso));
const newId = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2, 12)}`);

export default function ChatPanel({ role, endpoint, bookingId, intervalMs = 4000, title = "Messages", headers }: Props) {
  const headersKey = JSON.stringify(headers ?? {});
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [open, setOpen] = useState(true);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const lastAt = useRef<string | null>(null);
  const pendingId = useRef<string | null>(null); // reused when a failed send is retried, so it cannot be stored twice
  const endRef = useRef<HTMLDivElement>(null);
  const url = useCallback((after?: string | null) => {
    const q = new URLSearchParams(); if (bookingId) q.set("booking", bookingId); if (after) q.set("after", after);
    return `${endpoint}${q.toString() ? `?${q}` : ""}`;
  }, [endpoint, bookingId]);

  const merge = useCallback((incoming: ChatMessage[]) => {
    if (!incoming.length) return;
    setMessages((cur) => { const seen = new Set(cur.map((m) => m.id)); const add = incoming.filter((m) => !seen.has(m.id)); return add.length ? [...cur, ...add] : cur; });
    lastAt.current = incoming[incoming.length - 1].at;
  }, []);

  useEffect(() => {
    let stop = false;
    async function poll() {
      if (document.hidden) return;
      try {
        const res = await fetch(url(lastAt.current), { cache: "no-store", headers: JSON.parse(headersKey) });
        if (res.status === 401) return window.location.reload();
        if (res.status === 404 && lastAt.current !== null) return; // access ended (for example the ride was reassigned): keep what is shown, send nothing
        if (!res.ok) { if (!stop && lastAt.current === null) setState("error"); return; }
        const data = (await res.json()) as { messages: ChatMessage[]; open: boolean };
        if (stop) return;
        merge(data.messages); setOpen(data.open); setState("ready");
      } catch { if (!stop && lastAt.current === null) setState("error"); }
    }
    poll();
    const t = setInterval(poll, intervalMs);
    const onVis = () => { if (!document.hidden) poll(); };
    document.addEventListener("visibilitychange", onVis);
    return () => { stop = true; clearInterval(t); document.removeEventListener("visibilitychange", onVis); }; // no leaked timers or listeners
  }, [url, intervalMs, merge, headersKey]);

  useEffect(() => { endRef.current?.scrollIntoView({ block: "end" }); }, [messages.length]);

  async function send(body: string) {
    if (sending || !body.trim()) return;
    setSending(true); setError("");
    const clientId = pendingId.current ?? (pendingId.current = newId());
    try {
      const res = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json", ...JSON.parse(headersKey) }, body: JSON.stringify({ body, clientId, ...(bookingId ? { bookingId } : {}) }) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setError(data.error ?? "Could not send. Try again."); if (res.status !== 429 && res.status !== 500) pendingId.current = null; }
      else { pendingId.current = null; setText(""); merge([data.message]); }
    } catch { setError("Could not reach the server. Your message was not sent: tap Send to retry."); }
    setSending(false);
  }

  return (
    <section aria-label={title} className="panel" style={{ marginTop: "1rem" }}>
      <h3 style={{ marginBottom: ".5rem" }}>{title}</h3>
      <div role="log" aria-live="polite" aria-relevant="additions" style={{ maxHeight: 280, overflowY: "auto", display: "grid", gap: ".5rem", padding: ".25rem 0" }}>
        {state === "loading" && <p className="muted">Loading messages…</p>}
        {state === "error" && <p className="muted">Could not load messages. We will keep trying.</p>}
        {state === "ready" && messages.length === 0 && <p className="muted">No messages yet.</p>}
        {messages.map((m) => (
          <div key={m.id} style={{ justifySelf: m.role === role ? "end" : "start", maxWidth: "85%", padding: ".5rem .75rem", borderRadius: 10, background: m.role === role ? "var(--accent, #14161a)" : "rgba(128,128,128,.2)", color: m.role === role ? "#fff" : "inherit" }}>
            <div style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{m.body}</div>
            <small style={{ opacity: 0.7 }}>{m.role === role ? "You" : m.role === "driver" ? "Driver" : "Customer"} · {fmt(m.at)}</small>
          </div>
        ))}
        <div ref={endRef} />
      </div>
      {open ? (
        <>
          <div style={{ display: "flex", gap: ".4rem", flexWrap: "wrap", margin: ".5rem 0" }} aria-label="Quick replies">
            {QUICK_REPLIES[role].map((q) => <button key={q} type="button" className="btn btn--ghost" style={{ minHeight: 40, fontSize: ".85rem" }} disabled={sending} onClick={() => send(q)}>{q}</button>)}
          </div>
          <form onSubmit={(e) => { e.preventDefault(); void send(text); }} style={{ display: "flex", gap: ".5rem" }}>
            <label htmlFor={`chat-${bookingId ?? "c"}`} className="sr-only" style={{ position: "absolute", left: -9999 }}>Message</label>
            <input id={`chat-${bookingId ?? "c"}`} value={text} onChange={(e) => setText(e.target.value)} maxLength={MAX_MESSAGE} placeholder="Type a message" autoComplete="off" style={{ flex: 1, minHeight: 44 }} />
            <button className="btn btn--primary" type="submit" disabled={sending || !text.trim()} style={{ minHeight: 44 }}>{sending ? "Sending…" : "Send"}</button>
          </form>
          <p className="muted" style={{ marginTop: ".5rem", fontSize: ".8rem" }}>Messages are saved and can be reviewed by Vanta for support. Do not send card numbers or passwords.</p>
        </>
      ) : <p className="muted" style={{ marginTop: ".5rem" }}>Chat is closed because this ride is no longer open. Earlier messages are shown above.</p>}
      <div role="alert" aria-live="polite">{error && <div className="notice notice--error" style={{ marginTop: ".5rem" }}>{error}</div>}</div>
    </section>
  );
}
