"use client";

import { useState } from "react";

type Props = { initialSubject?: string; initialMessage?: string };
type Status = { kind: "idle" } | { kind: "sending" } | { kind: "ok" } | { kind: "error"; message: string; fields?: Record<string, string> };

export default function ContactForm({ initialSubject = "", initialMessage = "" }: Props) {
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (status.kind === "sending") return; // blocks double submission
    const form = e.currentTarget;
    const data = Object.fromEntries(new FormData(form).entries());
    setStatus({ kind: "sending" });
    try {
      const res = await fetch("/api/contact", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      const json = await res.json().catch(() => ({}));
      if (res.ok) {
        form.reset();
        setStatus({ kind: "ok" });
      } else {
        setStatus({ kind: "error", message: json.error ?? "Something went wrong. Please try again.", fields: json.fields });
      }
    } catch {
      setStatus({ kind: "error", message: "Could not reach the server. Check your connection and try again." });
    }
  }

  const err = status.kind === "error" ? status.fields ?? {} : {};
  const fieldError = (name: string) =>
    err[name] ? <span id={`${name}-err`} className="field__error">{err[name]}</span> : null;

  if (status.kind === "ok") {
    return (
      <div className="notice notice--ok" role="status">
        <strong>Message sent.</strong> We will get back to you using the details you provided.
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} noValidate className="form-grid" aria-describedby="form-status">
      <div className="field">
        <label htmlFor="name">Full name</label>
        <input id="name" name="name" autoComplete="name" required aria-invalid={!!err.name} aria-describedby={err.name ? "name-err" : undefined} />
        {fieldError("name")}
      </div>
      <div className="field">
        <label htmlFor="email">Email</label>
        <input id="email" name="email" type="email" autoComplete="email" required aria-invalid={!!err.email} aria-describedby={err.email ? "email-err" : undefined} />
        {fieldError("email")}
      </div>
      <div className="field">
        <label htmlFor="phone">Phone (optional)</label>
        <input id="phone" name="phone" type="tel" autoComplete="tel" aria-invalid={!!err.phone} aria-describedby={err.phone ? "phone-err" : undefined} />
        {fieldError("phone")}
      </div>
      <div className="field">
        <label htmlFor="subject">Subject</label>
        <input id="subject" name="subject" defaultValue={initialSubject} />
      </div>
      <div className="field full">
        <label htmlFor="message">How can we help?</label>
        <textarea id="message" name="message" required defaultValue={initialMessage} aria-invalid={!!err.message} aria-describedby={err.message ? "message-err" : undefined} />
        {fieldError("message")}
      </div>
      <div className="hp" aria-hidden="true">
        <label htmlFor="website">Leave this field empty</label>
        <input id="website" name="website" tabIndex={-1} autoComplete="off" />
      </div>
      <div className="full">
        <button className="btn btn--primary" type="submit" disabled={status.kind === "sending"}>
          {status.kind === "sending" ? "Sending…" : "Send message"}
        </button>
        <div id="form-status" role="status" aria-live="polite">
          {status.kind === "error" && <div className="notice notice--error">{status.message}</div>}
        </div>
      </div>
    </form>
  );
}
