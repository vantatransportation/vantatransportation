import type { Metadata } from "next";
import Image from "next/image";
import { getSiteData, services } from "@/lib/content";
import { CtaBand, FleetLedger } from "@/components/Sections";

export const metadata: Metadata = { title: "Rides we offer" };
export const revalidate = 60;

export default async function Rides() {
  const { content, categories, vehicles } = await getSiteData();
  const svc = services(content);
  return (
    <>
      <section className="page-head">
        <div className="container">
          <h1>Rides we offer</h1>
          <p className="lede">Pick the trip that fits, then the vehicle that fits your group.</p>
        </div>
      </section>

      {svc.length > 0 && (
        <section className="section">
          <div className="container">
            <div className="rides">
              {svc.map((s) => (
                <div key={s.title}>
                  <h3>{s.title}</h3>
                  <p>{s.description}</p>
                </div>
              ))}
            </div>
          </div>
        </section>
      )}

      <section className="section section--charcoal">
        <div className="container">
          <h2 style={{ marginBottom: "3rem" }}>Our vehicles</h2>
          {categories.map((c) => {
            const list = vehicles.filter((v) => v.categorySlug === c.slug);
            if (!list.length) return null;
            return (
              <div key={c.id} id={c.slug} style={{ marginBottom: "4rem", scrollMarginTop: "6rem" }}>
                <div style={{ display: "flex", gap: "1.5rem", alignItems: "center", marginBottom: "1.25rem", flexWrap: "wrap" }}>
                  <Image src={c.image} alt="" width={120} height={48} />
                  <div>
                    <h3>{c.name}</h3>
                    <p className="muted">{c.capacityLabel}. {c.description}</p>
                  </div>
                </div>
                <FleetLedger vehicles={list} />
              </div>
            );
          })}
          <p className="muted">Similar models may be provided. Rates are shown in your fare estimate.</p>
        </div>
      </section>
      <CtaBand />
    </>
  );
}
