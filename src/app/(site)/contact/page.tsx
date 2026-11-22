import type { Metadata } from "next";
import Link from "next/link";
import { getSiteData, text } from "@/lib/content";
import ContactForm from "@/components/ContactForm";
import SocialLinks from "@/components/SocialLinks";

export const metadata: Metadata = { title: "Contact" };

type SP = Promise<Record<string, string | string[] | undefined>>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";
const short = (s: string) => s.replace(/[\u0000-\u001F]/g, " ").slice(0, 200);

export default async function Contact({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const { content } = await getSiteData();
  const email = text(content, "contact.email");
  const phone = text(content, "contact.phone");
  const address = text(content, "contact.address");
  const hours = text(content, "contact.hours");

  // Trip details from the homepage strip are carried into the message.
  const pickup = short(one(sp.pickup));
  const dropoff = short(one(sp.dropoff));
  const date = short(one(sp.date));
  const time = short(one(sp.time));
  const lines = [pickup && `Pickup: ${pickup}`, dropoff && `Destination: ${dropoff}`, date && `Date: ${date}`, time && `Time: ${time}`].filter(Boolean);
  const isQuote = one(sp.topic) === "quote" || lines.length > 0;

  return (
    <>
      <section className="page-head">
        <div className="container">
          <h1>Contact</h1>
          <p className="lede">Ask a question or request a booking. We reply using the details you send.</p>
        </div>
      </section>
      <section className="section">
        <div className="container contact-grid">
          <div>
            <h2 style={{ fontSize: "2rem" }}>Details</h2>
            {phone || email || address || hours ? (
              <dl className="contact-list">
                {phone && <div><dt>Phone</dt><dd><a href={`tel:${phone.replace(/[^\d+]/g, "")}`}>{phone}</a></dd></div>}
                {email && <div><dt>Email</dt><dd><a href={`mailto:${email}`}>{email}</a></dd></div>}
                {address && <div><dt>Location</dt><dd>{address}</dd></div>}
                {hours && <div><dt>Hours</dt><dd>{hours}</dd></div>}
              </dl>
            ) : (
              <p className="muted" style={{ marginTop: "1rem" }}>Use the form and we will reply directly.</p>
            )}
            {address && (
              <div style={{ marginTop: "1.5rem" }}>
                {process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY && (
                  <iframe
                    title="Map of our location" loading="lazy" referrerPolicy="no-referrer-when-downgrade" style={{ width: "100%", height: 260, border: 0, filter: "grayscale(1) invert(.9) contrast(.9)" }}
                    src={`https://www.google.com/maps/embed/v1/place?key=${encodeURIComponent(process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY)}&q=${encodeURIComponent(address)}`}
                  />
                )}
                <p style={{ marginTop: ".75rem" }}>
                  <a className="btn btn--ghost" target="_blank" rel="noopener noreferrer" href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`}>Open in Google Maps</a>
                </p>
              </div>
            )}
            <div className="contact-social">
              <h3>Follow Us</h3>
              <p className="muted">Connect with Vanta Transportation on social media.</p>
              <SocialLinks />
            </div>
            <p style={{ marginTop: "2rem" }}>
              <Link href="/#faq" className="muted" style={{ textDecoration: "underline" }}>Read common questions</Link>
            </p>
            <p style={{ marginTop: ".75rem" }}><Link href="/book" className="btn btn--primary">Request a booking</Link></p>
          </div>
          <div id="form" style={{ scrollMarginTop: "6rem" }}>
            <h2 style={{ fontSize: "2rem", marginBottom: "1.5rem" }}>{isQuote ? "Request a booking" : "Send a message"}</h2>
            <ContactForm
              initialSubject={isQuote ? "Booking request" : ""}
              initialMessage={lines.length ? `${lines.join("\n")}\nPassengers: ` : ""}
            />
          </div>
        </div>
      </section>
    </>
  );
}
