"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import { postJson } from "./util";

/**
 * In-dashboard alerts plus optional native browser notifications (the browser Notifications API,
 * no third-party service). IMPORTANT LIMIT: notifications only fire while an admin dashboard tab is
 * open in the browser. Closing the browser stops them (Web Push is not implemented).
 */
interface Item { id: string; event: string; title: string; body: string; link: string; created_at: string; read: boolean }
type Perm = "unsupported" | "default" | "granted" | "denied";

const KEY = "vanta:admin-browser-notify";
const SEEN_KEY = "vanta:admin-notified";
const POLL_MS = 30_000;
const CHANGE = "vanta:notify-change";

const subscribe = (cb: () => void) => { window.addEventListener(CHANGE, cb); window.addEventListener("storage", cb); return () => { window.removeEventListener(CHANGE, cb); window.removeEventListener("storage", cb); }; };
const readPerm = (): Perm => (typeof Notification === "undefined" ? "unsupported" : (Notification.permission as Perm));
const readEnabled = () => { try { return localStorage.getItem(KEY) === "1"; } catch { return false; } };
const changed = () => window.dispatchEvent(new Event(CHANGE));

function alreadyNotified(id: string): boolean {
  try {
    const seen: string[] = JSON.parse(localStorage.getItem(SEEN_KEY) || "[]");
    if (seen.includes(id)) return true;
    localStorage.setItem(SEEN_KEY, JSON.stringify([...seen, id].slice(-100)));
  } catch { /* storage unavailable: the notification tag still de-duplicates in most browsers */ }
  return false;
}

export default function NotificationCenter() {
  const router = useRouter();
  const perm = useSyncExternalStore(subscribe, readPerm, () => "unsupported" as Perm);
  const enabled = useSyncExternalStore(subscribe, readEnabled, () => false);
  const [items, setItems] = useState<Item[]>([]);
  const [unread, setUnread] = useState(0);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");
  const known = useRef<Set<string> | null>(null);
  const live = useRef({ enabled, perm });
  useEffect(() => { live.current = { enabled, perm }; }, [enabled, perm]);

  const show = useCallback((n: Item) => {
    if (typeof Notification === "undefined" || Notification.permission !== "granted" || alreadyNotified(n.id)) return;
    try {
      const note = new Notification(n.title, { body: n.body, tag: n.id });
      note.onclick = () => { window.focus(); void postJson("/api/admin/notifications/read", { id: n.id }); router.push(n.link); note.close(); };
    } catch { /* some mobile browsers only allow service-worker notifications */ }
  }, [router]);

  useEffect(() => {
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function poll() {
      if (stop) return;
      if (!document.hidden) {
        try {
          const res = await fetch("/api/admin/notifications/feed", { cache: "no-store" });
          if (res.status === 401) { setError("Your session expired. Sign in again to keep receiving alerts."); return; }
          if (res.ok) {
            const data = (await res.json()) as { items: Item[]; unread: number };
            setError("");
            setItems(data.items); setUnread(data.unread);
            if (known.current === null) known.current = new Set(data.items.map((i) => i.id)); // first load: no pop-ups for old items
            else {
              const fresh = data.items.filter((i) => !known.current!.has(i.id) && !i.read).reverse();
              for (const n of fresh) { known.current.add(n.id); if (live.current.enabled && live.current.perm === "granted") show(n); }
            }
          }
        } catch { /* offline: try again next tick */ }
      }
      timer = setTimeout(poll, POLL_MS);
    }
    const onVisible = () => { if (!document.hidden) { if (timer) clearTimeout(timer); void poll(); } };
    document.addEventListener("visibilitychange", onVisible);
    void poll();
    return () => { stop = true; if (timer) clearTimeout(timer); document.removeEventListener("visibilitychange", onVisible); };
  }, [show]);

  async function enable() {
    if (typeof Notification === "undefined") return;
    if (Notification.permission === "default") await Notification.requestPermission(); // only ever called from this click
    if (Notification.permission === "granted") { try { localStorage.setItem(KEY, "1"); } catch { /* ignore */ } }
    changed();
  }
  function disable() { try { localStorage.setItem(KEY, "0"); } catch { /* ignore */ } changed(); }

  async function openItem(n: Item) {
    setOpen(false);
    if (!n.read) { setItems((l) => l.map((x) => (x.id === n.id ? { ...x, read: true } : x))); setUnread((u) => Math.max(0, u - 1)); void postJson("/api/admin/notifications/read", { id: n.id }); }
    router.push(n.link);
  }
  async function markAll() { setItems((l) => l.map((x) => ({ ...x, read: true }))); setUnread(0); await postJson("/api/admin/notifications/read", { all: true }); }

  const status =
    perm === "unsupported" ? "This browser does not support notifications. New items still appear here."
    : perm === "denied" ? "Browser notifications are blocked for this site. Allow them in your browser's site settings, then reload. New items still appear here."
    : enabled && perm === "granted" ? "Browser notifications are on. They work only while a dashboard tab is open."
    : "Browser notifications are off.";

  return (
    <div className="nc">
      <button type="button" className="nc__btn" aria-expanded={open} aria-controls="nc-panel" onClick={() => setOpen((o) => !o)}>
        Alerts {unread > 0 && <span className="nc__badge" aria-label={`${unread} unread`}>{unread}</span>}
      </button>
      {open && (
        <div id="nc-panel" className="nc__panel" role="region" aria-label="Notifications">
          <p className="nc__status" role="status">{error || status}</p>
          <div className="nc__actions">
            {perm !== "unsupported" && perm !== "denied" && (enabled && perm === "granted"
              ? <button type="button" className="btn btn--ghost btn-sm" onClick={disable}>Turn off browser notifications</button>
              : <button type="button" className="btn btn--primary btn-sm" onClick={enable}>Enable browser notifications</button>)}
            {unread > 0 && <button type="button" className="linkbtn" onClick={markAll}>Mark all read</button>}
          </div>
          <ul className="nc__list">
            {items.length === 0 && <li className="muted">No alerts yet.</li>}
            {items.slice(0, 12).map((n) => (
              <li key={n.id}><button type="button" className={`nc__item${n.read ? "" : " is-unread"}`} onClick={() => openItem(n)}><strong>{n.title}</strong><span>{n.body}</span></button></li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
