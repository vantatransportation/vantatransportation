import type { Metadata } from "next";
import TrackLookup from "@/components/TrackLookup";
import { BUSINESS_TZ } from "@/lib/config";

// The tracking ID is a credential: keep the page out of search engines and strip Referer.
export const metadata: Metadata = { title: "Track your ride", robots: { index: false, follow: false }, referrer: "no-referrer" };

export default function TrackPage() {
  return (
    <>
      <section className="page-head">
        <div className="container">
          <h1>Track Your Ride</h1>
          <p className="lede">Enter the tracking ID from your booking emails to see where your request stands, from review and payment through to your driver arriving.</p>
        </div>
      </section>
      <section className="section">
        <div className="container" style={{ maxWidth: 760 }}>
          <TrackLookup tz={BUSINESS_TZ} />
        </div>
      </section>
    </>
  );
}
