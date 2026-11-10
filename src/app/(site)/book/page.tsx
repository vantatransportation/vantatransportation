import type { Metadata } from "next";
import BookingForm from "@/components/BookingForm";
import { getAdminClient } from "@/lib/supabase/admin";
import { loadPublicPolicies } from "@/lib/policies";

export const metadata: Metadata = { title: "Request a booking" };
export const dynamic = "force-dynamic";

export default async function BookPage() {
  const policies = await loadPublicPolicies(getAdminClient());
  return (
    <>
      <section className="page-head">
        <div className="container">
          <h1>Request a booking</h1>
          <p className="lede">Your trip details are already filled in. Tell us who is booking, who is travelling and anything that helps the journey go smoothly. We confirm with you directly.</p>
        </div>
      </section>
      <section className="section">
        <div className="container"><BookingForm policies={policies} /></div>
      </section>
    </>
  );
}
