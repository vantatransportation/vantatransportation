import type { Metadata } from "next";
import { getSiteData, text } from "@/lib/content";
import { CtaBand, StandardsList } from "@/components/Sections";

export const metadata: Metadata = { title: "About us" };
export const revalidate = 60;

export default async function About() {
  const { content, standards } = await getSiteData();
  const paragraphs = text(content, "about.body").split(/\n{2,}/).filter(Boolean);
  return (
    <>
      <section className="page-head">
        <div className="container">
          <h1>{text(content, "about.title", "About us")}</h1>
        </div>
      </section>
      <section className="section">
        <div className="container split">
          <div>
            {paragraphs.map((p, i) => (
              <p key={i} className="lede" style={{ marginBottom: "1.25rem" }}>{p}</p>
            ))}
          </div>
          <div>
            <h2 style={{ marginBottom: "1.5rem", fontSize: "2rem" }}>Our standards</h2>
            <div style={{ background: "var(--light)", color: "#1b1c1e", padding: "1.25rem 1.5rem" }}>
              <StandardsList standards={standards} />
            </div>
          </div>
        </div>
      </section>
      <CtaBand />
    </>
  );
}
