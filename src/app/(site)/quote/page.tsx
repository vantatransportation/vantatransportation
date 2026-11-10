import type { Metadata } from "next";
import Link from "next/link";
import ManualQuoteForm from "@/components/ManualQuoteForm";
import { getSiteData, text } from "@/lib/content";

export const metadata: Metadata = { title: "Get a quote" };
export const revalidate = 60;

export default async function QuotePage() {
  const { content } = await getSiteData();
  return (
    <>
      <section className="page-head">
        <div className="container">
          <h1>Get a quote</h1>
          <p className="lede">Need a custom price, a trip outside our usual area, or something that needs a person to look at it? Tell us about it and we will reply.</p>
        </div>
      </section>
      <section className="section">
        <div className="container contact-grid">
          <div>
            <h2 style={{ fontSize: "2rem" }}>How it works</h2>
            <p className="muted" style={{ marginTop: "1rem" }}>A quote request is not a booking, and a custom quote is not guaranteed to be lower than an estimate. We confirm availability before anything is booked.</p>
            <p className="muted" style={{ marginTop: "1rem" }}>{text(content, "coverage.other")}</p>
            <p className="muted" style={{ marginTop: "1rem" }}>{text(content, "policy.availability")}</p>
            <p style={{ marginTop: "1.5rem" }}>Prefer an instant estimate for a standard trip? <Link href="/#categories" style={{ textDecoration: "underline" }}>Browse vehicles</Link> or use <strong>BOOK A RIDE</strong>.</p>
          </div>
          <div><ManualQuoteForm /></div>
        </div>
      </section>
    </>
  );
}
