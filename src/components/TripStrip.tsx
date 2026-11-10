"use client";

import { openCalculator } from "@/lib/calculator-events";

/** Homepage booking entry point: hands the entered trip to the fare calculator. */
export default function TripStrip({ cta }: { cta: string }) {
  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    openCalculator({ pickup: String(fd.get("pickup") ?? ""), dropoff: String(fd.get("dropoff") ?? ""), date: String(fd.get("date") ?? ""), time: String(fd.get("time") ?? "") });
  }
  return (
    <form className="trip" onSubmit={onSubmit} aria-label="Start your trip">
      <p className="trip__title">Where are you going?</p>
      <div className="field"><label htmlFor="t-pickup">Pickup</label><input id="t-pickup" name="pickup" placeholder="Address or airport" autoComplete="off" /></div>
      <div className="field"><label htmlFor="t-drop">Destination</label><input id="t-drop" name="dropoff" placeholder="Address or airport" autoComplete="off" /></div>
      <div className="field"><label htmlFor="t-date">Date</label><input id="t-date" name="date" type="date" /></div>
      <div className="field"><label htmlFor="t-time">Time</label><input id="t-time" name="time" type="time" /></div>
      <button className="btn btn--primary" type="submit">{cta}</button>
    </form>
  );
}
