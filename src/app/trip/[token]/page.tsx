import Link from "next/link";
import TripStatus from "@/components/TripStatus";
import { getAdminClient } from "@/lib/supabase/admin";
import { loadTrip } from "@/lib/trip";
import { BUSINESS_TZ } from "@/lib/config";

export const dynamic = "force-dynamic";
// The private link is the credential: keep it out of search engines and out of Referer headers.
export const metadata = { title: "Your booking", robots: { index: false, follow: false }, referrer: "no-referrer" as const };

export default async function TripPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const db = getAdminClient();
  const t = db ? await loadTrip(db, token) : null;
  return (
    <div style={{ maxWidth: 720, margin: "0 auto", padding: "1.5rem 1rem 4rem" }}>
      <h1>Your booking</h1>
      {t ? <TripStatus credential={{ kind: "token", token }} initial={t.view} tz={BUSINESS_TZ} /> : (
        <div className="notice notice--error">This link is not valid. Please use the link in your booking email, or <Link href="/contact" style={{ textDecoration: "underline" }}>contact us</Link>.</div>
      )}
    </div>
  );
}
