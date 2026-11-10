import { notFound } from "next/navigation";
import ResourceManager from "@/components/admin/ResourceManager";
import { adminPage, listRows, loadRefOptions } from "@/lib/admin/data";
import { resources, toClient } from "@/lib/admin/resources";
import { BUSINESS_TZ } from "@/lib/config";

const GENERIC = ["vehicles", "standards", "faqs", "promotions", "follow-ups", "bookings", "customers", "leads", "quotes", "booking-settings", "round-trip"];
const BLURB: Record<string, string> = {
  vehicles: "Add and edit vehicles, upload images, set capacity, and control whether each is shown and bookable. Pricing is managed under Pricing management.",
  standards: "These appear in the Standards section of the public website. Add or edit them as requirements change.",
  faqs: "These power the FAQ chat button and the homepage FAQ list. Use the arrows to reorder.",
  promotions: "Controls the promotional popup. Only the most recently created active promotion within its dates is shown.",
  "follow-ups": "Reminders to contact customers. Overdue items are counted on the Overview.",
  bookings: "All booking requests. Open one to edit details, change status and add notes.",
  customers: "Everyone who has booked, enquired or requested a quote. Returning customers are matched by email or phone.",
  leads: "Contact-form inquiries. Open one to change its status, add notes and set follow-ups.",
  "booking-settings": "Meet & Greet availability and charge, and waiting-time allowance and rate. Charges stay hidden or marked \"to be confirmed\" until you approve them.",
  "round-trip": "Round-trip discount rules. No discount applies until you create and activate a rule. Customers always see both legs, the discount and the final total.",
  quotes: "Customers asking for a better price. Open one to review, set a revised price and respond.",
};

export default async function Page({ params }: { params: Promise<{ resource: string }> }) {
  const { resource: slug } = await params;
  const r = resources[slug];
  if (!r || !GENERIC.includes(slug)) notFound();
  const { db } = await adminPage();
  const [rows, refOptions] = await Promise.all([listRows(db, r), loadRefOptions(db, r)]);
  return (
    <>
      <h1>{r.title}</h1>
      <p className="adm-sub">{BLURB[slug]}</p>
      <ResourceManager resource={toClient(r)} rows={rows} refOptions={refOptions} tz={BUSINESS_TZ} />
    </>
  );
}
