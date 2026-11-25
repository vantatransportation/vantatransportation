import ResourceManager from "@/components/admin/ResourceManager";
import { adminPage, listRows, loadRefOptions } from "@/lib/admin/data";
import { resources, toClient } from "@/lib/admin/resources";
import { BUSINESS_TZ } from "@/lib/config";

export const metadata = { title: "Pricing management" };

export default async function Pricing() {
  const { db } = await adminPage();
  const [configs, surcharges, discounts, vehicles, cfgRefs, surRefs] = await Promise.all([
    listRows(db, resources.pricing), listRows(db, resources.surcharges), listRows(db, resources.discounts),
    db.from("vehicles").select("id,name").eq("is_active", true).order("sort_order"),
    loadRefOptions(db, resources.pricing), loadRefOptions(db, resources.surcharges),
  ]);
  const activeVehicleIds = new Set(configs.filter((c) => c.status === "active").map((c) => String(c.vehicle_id)));
  const unpriced = ((vehicles.data ?? []) as { id: string; name: string }[]).filter((v) => !activeVehicleIds.has(v.id));

  return (
    <>
      <h1>Pricing management</h1>
      <p className="adm-sub">
        Each vehicle has its own pricing. Customers only receive online quotes for vehicles with an <strong>active</strong> configuration. The seeded values are
        unconfirmed draft research; review them, edit as needed, then set the status to Active to publish. Activating a configuration archives the vehicle&apos;s previous active one.
        Past bookings keep the price snapshot they were quoted with.
      </p>
      {unpriced.length > 0 && <div className="banner">No active pricing (customers cannot get an online quote): {unpriced.map((v) => v.name).join(", ")}</div>}
      <ResourceManager resource={toClient(resources.pricing)} rows={configs} refOptions={cfgRefs} tz={BUSINESS_TZ} createLabel="Add pricing configuration" />
      <h2>Surcharges</h2>
      <p className="adm-sub">Optional flat or percentage charges added to a vehicle&apos;s fare while that configuration is active.</p>
      <ResourceManager resource={toClient(resources.surcharges)} rows={surcharges} refOptions={surRefs} tz={BUSINESS_TZ} />
      <h2>Promo codes</h2>
      <p className="adm-sub">Codes customers can enter in the fare calculator. A code you create here counts as approved. Individual negotiated discounts are handled under Quote requests.</p>
      <ResourceManager resource={toClient(resources.discounts)} rows={discounts} tz={BUSINESS_TZ} />
    </>
  );
}
