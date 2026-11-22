import FamilyEditor from "@/components/admin/FamilyEditor";
import { adminPage } from "@/lib/admin/data";
import { FAMILY_DEFAULTS, FAMILY_PREFIX, buildFamilyInput } from "@/lib/family-section";

export const metadata = { title: "Family section" };

export default async function FamilyAdmin() {
  const { db } = await adminPage();
  const { data } = await db.from("site_content").select("key,value").like("key", `${FAMILY_PREFIX}%`);
  const map: Record<string, unknown> = {};
  for (const r of (data ?? []) as { key: string; value: unknown }[]) map[r.key] = r.value;
  const initial = buildFamilyInput(map);
  return (
    <>
      <h1>Family section</h1>
      <p className="adm-sub">The &ldquo;{FAMILY_DEFAULTS.title}&rdquo; block on the home page: heading, text, closing line, image, and an on/off switch. Changes appear within moments.</p>
      <FamilyEditor key={JSON.stringify(initial)} initial={initial} />
    </>
  );
}
