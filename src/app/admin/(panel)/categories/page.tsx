import ResourceManager from "@/components/admin/ResourceManager";
import { adminPage, listRows } from "@/lib/admin/data";
import { resources, toClient } from "@/lib/admin/resources";
import { BUSINESS_TZ } from "@/lib/config";

export const metadata = { title: "Vehicle categories" };

export default async function Categories() {
  const { db } = await adminPage();
  const [cats, tiers] = await Promise.all([listRows(db, resources.categories), listRows(db, resources.tiers)]);
  return (
    <>
      <h1>Vehicle categories</h1>
      <p className="adm-sub">Categories group vehicles on the website. Tiers (currently Business Class and First Class; rename them here, for example to Luxury and Premium) are separate and can be renamed or extended at any time. Use the arrows to reorder.</p>
      <ResourceManager resource={toClient(resources.categories)} rows={cats} tz={BUSINESS_TZ} />
      <h2>Vehicle tiers</h2>
      <ResourceManager resource={toClient(resources.tiers)} rows={tiers} tz={BUSINESS_TZ} />
    </>
  );
}
