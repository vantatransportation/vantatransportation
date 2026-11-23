import { requireDriver } from "@/lib/driver/auth";
import { loadDriverRides } from "@/lib/driver/rides";
import { getAdminClient } from "@/lib/supabase/admin";
import DriverDashboard from "@/components/driver/DriverDashboard";
import { BUSINESS_TZ } from "@/lib/config";
import { getHelpline } from "@/lib/helpline";

export const metadata = { title: "My rides" };
export const dynamic = "force-dynamic";

export default async function Page() {
  const driver = await requireDriver();
  const db = getAdminClient();
  const rides = db ? await loadDriverRides(db, driver.id) : [];
  const helpline = db ? await getHelpline(db) : null;
  return <DriverDashboard name={driver.name} plate={driver.plate} initial={rides} tz={BUSINESS_TZ} helpline={helpline} serverNow={new Date().toISOString()} />;
}
