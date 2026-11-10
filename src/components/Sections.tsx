import Image from "next/image";
import Link from "next/link";
import OpenCalculator from "./OpenCalculator";
import type { Category, Faq, Standard, Vehicle } from "@/lib/types";
import VehiclePhoto from "./VehiclePhoto";
import { hasRealPhoto } from "@/lib/vehicle-photo";

/** Category tiles: a real photo of a vehicle in the category when one exists, otherwise the neutral category icon. */
export function CategoryGrid({ categories, vehicles = [] }: { categories: Category[]; vehicles?: Vehicle[] }) {
  return (
    <div className="cats">
      {categories.map((c) => {
        const photo = vehicles.find((v) => v.categorySlug === c.slug && hasRealPhoto(v.image));
        return (
          <Link key={c.id} href={`/rides#${c.slug}`} className="cat">
            {photo ? <VehiclePhoto src={photo.image} name={photo.name} width={640} height={400} /> : <Image src={c.image} alt="" width={400} height={160} loading="lazy" className="cat__icon" />}
            <h3>{c.name}</h3>
            <span className="cat__cap">{c.capacityLabel}</span>
            <p>{c.description}</p>
          </Link>
        );
      })}
    </div>
  );
}

/** Fleet cards with the vehicle photograph, tier, capacity and a short description. No prices here: they depend on the trip. */
export function FleetLedger({ vehicles }: { vehicles: Vehicle[] }) {
  return (
    <div className="fleet">
      {vehicles.map((v) => (
        <article key={v.id} className="fleet__card">
          <VehiclePhoto src={v.image} name={v.name} width={640} height={400} />
          <div className="fleet__body">
            <h3>{v.name}</h3>
            <p className="fleet__meta">
              {v.tierName && <span className="tier-badge">{v.tierName}</span>}
              <span>{v.capacityLabel || `Up to ${v.passengers} passengers`}</span>
            </p>
            <p>{v.description || v.similarModels}</p>
            {v.similarModels && v.description && <p className="muted">{v.similarModels}</p>}
            {!v.isAvailable && <span className="badge">Currently unavailable</span>}
          </div>
        </article>
      ))}
    </div>
  );
}

export function StandardsList({ standards }: { standards: Standard[] }) {
  return (
    <ul className="standards">
      {standards.map((s) => (
        <li key={s.id}>
          <strong>{s.title}</strong>
          <span>{s.description}</span>
        </li>
      ))}
    </ul>
  );
}

export function FaqList({ faqs }: { faqs: Faq[] }) {
  return (
    <div className="faq">
      {faqs.map((f) => (
        <details key={f.id}>
          <summary>{f.question}</summary>
          <p>{f.answer}</p>
        </details>
      ))}
    </div>
  );
}

export function CtaBand({ title = "Ready to book your ride?" }: { title?: string }) {
  return (
    <section className="cta section">
      <div className="container cta__inner">
        <h2>{title}</h2>
        <div className="hero__actions">
          <OpenCalculator className="btn btn--primary">BOOK A RIDE</OpenCalculator>
          <Link href="/quote" className="btn btn--ghost">GET A QUOTE</Link>
        </div>
      </div>
    </section>
  );
}

export function TrustSection({ title, points }: { title: string; points: { title: string; description: string }[] }) {
  if (!points.length) return null;
  return (
    <section className="section section--charcoal" id="family" aria-labelledby="family-title">
      <div className="container">
        <h2 id="family-title" style={{ marginBottom: "2.5rem" }}>{title}</h2>
        <div className="trust">
          {points.map((p) => (<div key={p.title} className="trust__item"><h3>{p.title}</h3><p>{p.description}</p></div>))}
        </div>
      </div>
    </section>
  );
}

export function CoverageSection({ primary, eastCoast, other }: { primary: string; eastCoast: string; other: string }) {
  const tiers: [string, string, string][] = [["Primary focus", "DMV and greater Baltimore", primary], ["Wider East Coast", "North Carolina to New York", eastCoast], ["Beyond the corridor", "Other U.S. and selected European cities", other]];
  return (
    <section className="section" id="coverage" aria-labelledby="coverage-title">
      <div className="container">
        <h2 id="coverage-title" style={{ marginBottom: "1rem" }}>Where we can take you</h2>
        <p className="muted" style={{ marginBottom: "2.5rem" }}>Requests are welcome anywhere. We do not operate our own fleet in every city, and availability is never guaranteed until we confirm it with you.</p>
        <ol className="coverage">
          {tiers.map(([k, t, body]) => (<li key={k}><span className="coverage__tag">{k}</span><h3>{t}</h3><p>{body}</p></li>))}
        </ol>
      </div>
    </section>
  );
}

export function ServiceNotes({ waiting, noShow, assistance, availability, meetGreetEnabled }: { waiting: string; noShow: string; assistance: string; availability: string; meetGreetEnabled: boolean }) {
  return (
    <section className="section section--light" id="policies" aria-labelledby="policies-title">
      <div className="container">
        <h2 id="policies-title" style={{ marginBottom: "2rem" }}>What to expect</h2>
        <div className="notes">
          <div><h3>Passenger assistance</h3><p>{assistance}</p></div>
          {meetGreetEnabled && <div><h3>Airport Meet &amp; Greet</h3><p>Choose Meet &amp; Greet on an airport pickup to request that your driver meets the passenger inside the airport. It is a request until we confirm it, and any charge is shown or confirmed before service.</p></div>}
          <div><h3>Waiting time</h3><p>{waiting}</p></div>
          <div><h3>No-shows</h3><p>{noShow}</p></div>
          <div><h3>Availability</h3><p>{availability}</p></div>
        </div>
      </div>
    </section>
  );
}
