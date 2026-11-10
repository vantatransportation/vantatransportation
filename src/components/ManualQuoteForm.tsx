"use client";

import { useState } from "react";
import { newKey } from "@/lib/uuid";
import { BETTER_QUOTE_DISCLAIMER, BETTER_QUOTE_REMINDER } from "@/lib/policy-text";

type Status = { kind: "idle" } | { kind: "sending" } | { kind: "ok" } | { kind: "error"; message: string; fields?: Record<string, string> };

/** "Get a Quote": a request for a custom price or an arrangement that needs manual review. Not a booking. */
export default function ManualQuoteForm() {
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [key] = useState(newKey);
  const [today] = useState(() => new Date().toISOString().slice(0, 10));

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (status.kind === "sending") return;
    const fd = Object.fromEntries(new FormData(e.currentTarget).entries()) as Record<string, string>;
    setStatus({ kind: "sending" });
    try {
      const res = await fetch("/api/quote-requests", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: fd.name, email: fd.email, phone: fd.phone, message: fd.message, desiredBudget: fd.budget, website: fd.website, submissionKey: key,
          trip: { pickup: { text: fd.pickup }, dropoff: { text: fd.dropoff }, stops: [], date: fd.date, time: fd.time, tripType: "distance", passengers: Number(fd.passengers) || 0 },
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) setStatus({ kind: "ok" }); // shown only after the request was saved
      else setStatus({ kind: "error", message: data.error ?? "Something went wrong. Please try again.", fields: data.fields });
    } catch {
      setStatus({ kind: "error", message: "Could not reach the server. Your details are still on this page; please try again." });
    }
  }

  if (status.kind === "ok") {
    return <div className="notice notice--ok" role="status"><strong>Quote request received.</strong> We will review it and reply using the details you gave. This is a request, not a confirmed booking. {BETTER_QUOTE_REMINDER}</div>;
  }
  const err = status.kind === "error" ? status.fields ?? {} : {};
  const fe = (n: string) => (err[n] ? <span className="field__error">{err[n]}</span> : null);

  return (
    <form onSubmit={submit} noValidate className="form-grid" aria-label="Get a quote">
      <div className="field"><label htmlFor="mq-name">Full name</label><input id="mq-name" name="name" autoComplete="name" required aria-invalid={!!err.name} />{fe("name")}</div>
      <div className="field"><label htmlFor="mq-email">Email</label><input id="mq-email" name="email" type="email" autoComplete="email" required aria-invalid={!!err.email} />{fe("email")}</div>
      <div className="field"><label htmlFor="mq-phone">Phone</label><input id="mq-phone" name="phone" type="tel" autoComplete="tel" required aria-invalid={!!err.phone} />{fe("phone")}</div>
      <div className="field"><label htmlFor="mq-pax">Passengers</label><input id="mq-pax" name="passengers" type="number" min={1} max={50} defaultValue={2} /></div>
      <div className="field full"><label htmlFor="mq-from">Pickup (city, address or airport)</label><input id="mq-from" name="pickup" required autoComplete="off" /></div>
      <div className="field full"><label htmlFor="mq-to">Destination (any city or airport)</label><input id="mq-to" name="dropoff" required autoComplete="off" /></div>
      <div className="field"><label htmlFor="mq-date">Pickup date</label><input id="mq-date" name="date" type="date" min={today} required /></div>
      <div className="field"><label htmlFor="mq-time">Pickup time</label><input id="mq-time" name="time" type="time" required /></div>
      <div className="field"><label htmlFor="mq-budget">Your budget in dollars (optional)</label><input id="mq-budget" name="budget" type="number" min={0} />{fe("desiredBudget")}</div>
      <div className="field full"><label htmlFor="mq-msg">Anything we should know (optional)</label><textarea id="mq-msg" name="message" /></div>
      <div className="hp" aria-hidden="true"><label htmlFor="mq-web">Leave empty</label><input id="mq-web" name="website" tabIndex={-1} autoComplete="off" /></div>
      <p className="notice full" role="note"><strong>Please note.</strong> {BETTER_QUOTE_DISCLAIMER}</p>
      <div className="full">
        <button className="btn btn--primary" type="submit" disabled={status.kind === "sending"}>{status.kind === "sending" ? "Sending…" : "Send quote request"}</button>
        <div role="alert" aria-live="polite">{status.kind === "error" && <div className="notice notice--error">{status.message}</div>}</div>
      </div>
    </form>
  );
}
