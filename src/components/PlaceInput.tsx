"use client";

import { useEffect, useId, useRef, useState } from "react";

export interface PlaceValue { text: string; placeId?: string }
interface Suggestion { text: string; placeId: string }

/** Address field with server-proxied Google Places suggestions. Free text is also accepted. */
export default function PlaceInput({ label, value, onChange, placeholder, onUnavailable, sessionToken }: {
  label: string; value: PlaceValue; onChange: (v: PlaceValue) => void; placeholder?: string; onUnavailable?: () => void; sessionToken: string;
}) {
  const id = useId();
  const [items, setItems] = useState<Suggestion[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const seq = useRef(0);

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  function onInput(text: string) {
    onChange({ text });
    if (timer.current) clearTimeout(timer.current);
    if (text.trim().length < 3) { setItems([]); setOpen(false); return; }
    timer.current = setTimeout(async () => {
      const mine = ++seq.current;
      try {
        const res = await fetch("/api/places/autocomplete", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ input: text, sessionToken }) });
        if (res.status === 503) { onUnavailable?.(); return; }
        const data = await res.json().catch(() => ({ suggestions: [] }));
        if (mine !== seq.current) return; // a newer request superseded this one
        setItems(data.suggestions ?? []);
        setOpen((data.suggestions ?? []).length > 0);
        setActive(-1);
      } catch {
        /* suggestions are optional */
      }
    }, 250);
  }

  function pick(s: Suggestion) {
    onChange({ text: s.text, placeId: s.placeId });
    setOpen(false);
    setItems([]);
  }

  function onKey(e: React.KeyboardEvent) {
    if (!open) return;
    if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(a + 1, items.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
    else if (e.key === "Enter" && active >= 0) { e.preventDefault(); pick(items[active]); }
    else if (e.key === "Escape") { e.stopPropagation(); setOpen(false); }
  }

  return (
    <div className="field place">
      <label htmlFor={id}>{label}</label>
      <input
        id={id} value={value.text} placeholder={placeholder} autoComplete="off" role="combobox" aria-expanded={open} aria-controls={`${id}-list`} aria-autocomplete="list"
        onChange={(e) => onInput(e.target.value)} onKeyDown={onKey} onBlur={() => setTimeout(() => setOpen(false), 150)} onFocus={() => items.length > 0 && setOpen(true)}
      />
      {open && (
        <ul id={`${id}-list`} role="listbox" className="place__list">
          {items.map((s, i) => (
            <li key={s.placeId} role="option" aria-selected={i === active} className={i === active ? "is-active" : ""} onMouseDown={(e) => { e.preventDefault(); pick(s); }}>{s.text}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
