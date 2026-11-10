import NotificationsTable, { type LogRow } from "@/components/admin/NotificationsTable";
import { adminPage } from "@/lib/admin/data";
import { configWarnings } from "@/lib/notify";
import { BUSINESS_TZ } from "@/lib/config";

export const metadata = { title: "Notifications" };

export default async function Notifications() {
  const { db } = await adminPage();
  const { data } = await db.from("notification_logs").select("id,channel,event,status,attempts,error,created_at,last_attempt_at").order("created_at", { ascending: false }).limit(200);
  const warnings = configWarnings().filter((w) => ["email", "payments", "photos"].includes(w.channel));
  return (
    <>
      <h1>Notifications</h1>
      <p className="adm-sub">Every email attempt (sent through Brevo) is logged; older SMS rows are kept as history. Use the Alerts button in the sidebar for in-dashboard and browser notifications. Bookings and inquiries are always saved even if a notification fails. Failed or skipped messages can be retried here.</p>
      {warnings.map((w) => <div key={w.message} className="banner">{w.message}</div>)}
      <NotificationsTable rows={(data ?? []) as LogRow[]} tz={BUSINESS_TZ} />
    </>
  );
}
