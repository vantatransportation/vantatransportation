"use client";

import Link from "next/link";
import { openCalculator } from "@/lib/calculator-events";
import { useEffect, useRef, useState } from "react";
import type { Faq } from "@/lib/types";

type Msg = { from: "bot" | "user"; text: string };

export default function FloatingActions({ faqs }: { faqs: Faq[] }) {
  const [open, setOpen] = useState(false);
  const [msgs, setMsgs] = useState<Msg[]>([{ from: "bot", text: "Hello. Choose a question and we will answer it." }]);
  const bodyRef = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        toggleRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  useEffect(() => {
    bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight });
  }, [msgs]);

  const ask = (f: Faq) =>
    setMsgs((m) => [...m, { from: "user", text: f.question }, { from: "bot", text: f.answer }]);

  return (
    <>
      <div className="fab-fare">
        <Link href="/quote" className="btn btn--ghost">GET A QUOTE</Link>
        <button type="button" className="btn btn--primary" onClick={() => openCalculator()}>BOOK A RIDE</button>
      </div>

      <button
        ref={toggleRef}
        className="fab-chat"
        aria-label={open ? "Close questions" : "Open questions"}
        aria-expanded={open}
        aria-controls="faq-chat"
        onClick={() => setOpen((o) => !o)}
      >
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
          <path d="M4 5h16v11H9l-5 4V5z" strokeLinejoin="round" />
        </svg>
      </button>

      {open && (
        <div id="faq-chat" className="chat" role="dialog" aria-label="Frequently asked questions">
          <div className="chat__head">
            Questions
            <button className="chat__close" aria-label="Close questions" onClick={() => setOpen(false)}>×</button>
          </div>
          <div className="chat__body" ref={bodyRef} aria-live="polite">
            {msgs.map((m, i) => (
              <div key={i} className={`bubble bubble--${m.from}`}>{m.text}</div>
            ))}
            {faqs.length > 0 ? (
              <div className="chips">
                {faqs.map((f) => (
                  <button key={f.id} className="chip" onClick={() => ask(f)}>{f.question}</button>
                ))}
              </div>
            ) : (
              <div className="bubble bubble--bot">There are no questions listed yet. Send us a message instead.</div>
            )}
          </div>
          <div className="chat__links">
            <span className="muted">Still need help?</span>
            <Link href="/contact#form" onClick={() => setOpen(false)}>Contact us</Link>
            <Link href="/quote" onClick={() => setOpen(false)}>Get a quote</Link>
            <button type="button" className="linkbtn" onClick={() => { setOpen(false); openCalculator(); }}>Book a ride</button>
          </div>
        </div>
      )}
    </>
  );
}
