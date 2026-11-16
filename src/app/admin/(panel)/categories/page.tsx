import ResourceManager from "@/components/admin/ResourceManager";
import { adminPage, listRows } from "@/lib/admin/data";
import { resources, toClient } from "@/lib/admin/resources";
import { BUSINESS_TZ } from "@/lib/config";

export const metadata = { title: "Vehicle categories" };

export default async function Categories() {
  const { db } = await adminPage();
  const cats = await listRows(db, resources.categories);
  return (
    <>
      <h1>Vehicle categories</h1>
      <p className="adm-sub">Categories group vehicles on the website. The three service tiers (Premium, Luxury, Luxury Plus) and their fixed prices and Meet & Greet fees are under Tier prices & fees. Use the arrows to reorder categories.</p>
      <ResourceManager resource={toClient(resources.categories)} rows={cats} tz={BUSINESS_TZ} />
    </>
  );
}
