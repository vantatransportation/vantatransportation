import Image from "next/image";
import Link from "next/link";
import { getSiteData, listOf, text } from "@/lib/content";
import OpenCalculator from "@/components/OpenCalculator";
import TripStrip from "@/components/TripStrip";
import { CategoryGrid, CoverageSection, CtaBand, FaqList, FleetLedger, ServiceNotes, StandardsList, TrustSection } from "@/components/Sections";
import { getAdminClient } from "@/lib/supabase/admin";
import { loadPublicPolicies } from "@/lib/policies";

export const revalidate = 60;

export default async function Home() {
  const { content, categories, vehicles, standards, faqs } = await getSiteData();
  const featured = vehicles.slice(0, 6);
  const policies = await loadPublicPolicies(getAdminClient());

  return (
    <>
      <section className="hero">
        <div className="container">
          <div className="hero__grid">
            <div>
              <h1>{text(content, "hero.title", "Chauffeured travel, handled properly.")}</h1>
              <p className="lede">{text(content, "hero.subtitle")}</p>
              <div className="hero__actions">
                <OpenCalculator className="btn btn--primary">{text(content, "hero.cta_primary", "BOOK A RIDE")}</OpenCalculator>
                <Link href="/quote" className="btn btn--ghost">{text(content, "hero.cta_secondary", "GET A QUOTE")}</Link>
              </div>
              <p className="hero__note">{text(content, "contact.hours")}</p>
            </div>
            <div className="hero__mark">
              <Image src="/brand/vanta-mark.svg" alt="Vanta Transportation" width={460} height={288} priority />
            </div>
          </div>
          <TripStrip cta="See my fare" />
        </div>
      </section>

      <TrustSection title="Thoughtful rides for the people who matter most" points={listOf(content, "trust.points")} />

      <section className="section" id="categories">
        <div className="container">
          <div className="section-head">
            <h2>{text(content, "home.categories_title", "Choose the right vehicle")}</h2>
            <p className="muted">{text(content, "home.categories_sub")}</p>
          </div>
          <CategoryGrid categories={categories} vehicles={vehicles} />
        </div>
      </section>

      <section className="section section--charcoal">
        <div className="container">
          <div className="section-head">
            <h2>{text(content, "home.fleet_title", "The fleet")}</h2>
            <Link href="/rides" className="btn btn--ghost">See all rides</Link>
          </div>
          <FleetLedger vehicles={featured} />
          <p className="muted" style={{ marginTop: "1.5rem" }}>
            {text(content, "home.fleet_note")}
          </p>
        </div>
      </section>

      <CoverageSection primary={text(content, "coverage.primary")} eastCoast={text(content, "coverage.east_coast")} other={text(content, "coverage.other")} />

      <section className="section section--light" id="standards">
        <div className="container split">
          <div>
            <h2>{text(content, "home.standards_title", "Every vehicle, every driver, the same standard")}</h2>
            <p className="muted" style={{ marginTop: "1.25rem" }}>
              What you see here is what arrives at your door.
            </p>
          </div>
          <StandardsList standards={standards} />
        </div>
      </section>

      <section className="section">
        <div className="container">
          <h2 style={{ marginBottom: "3rem" }}>{text(content, "home.why_title", "Why travel with Vanta")}</h2>
          <div className="pillars">
            {listOf(content, "pillars").map((p) => (
              <div key={p.title}>
                <h3>{p.title}</h3>
                <p>{p.description}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="section section--charcoal">
        <div className="container">
          <h2 style={{ marginBottom: "3rem" }}>How booking works</h2>
          <ol className="steps">
            <li>
              <h3>Book a ride or get a quote</h3>
              <p>Enter your trip for an estimate, add a return trip if you need one, or ask for a custom quote.</p>
            </li>
            <li>
              <h3>Send your request</h3>
              <p>Add who is travelling, an optional contact, and airport details if needed.</p>
            </li>
            <li>
              <h3>We confirm with you</h3>
              <p>No online payment is taken. A request is not a confirmed booking until we confirm it with you.</p>
            </li>
          </ol>
        </div>
      </section>

      <ServiceNotes waiting={policies.waitingText} noShow={policies.noShowText} assistance={policies.assistanceText} availability={policies.availabilityText} meetGreetEnabled={policies.meetGreet.enabled} />

      {faqs.length > 0 && (
        <section className="section" id="faq">
          <div className="container">
            <h2 style={{ marginBottom: "2.5rem" }}>Questions</h2>
            <FaqList faqs={faqs} />
          </div>
        </section>
      )}

      <CtaBand title={text(content, "home.cta_title", "Ready to book your ride?")} />
    </>
  );
}
