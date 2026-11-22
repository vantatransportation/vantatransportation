import FamilyEditor from "@/components/admin/FamilyEditor";
import { adminPage } from "@/lib/admin/data";
import { FAMILY_DEFAULTS, buildFamilyInput } from "@/lib/family-section";
import { readFamilyRows } from "@/lib/family-data";

export const metadata = { title: "Family section" };

export default async function FamilyAdmin() {
  const { db } = await adminPage();
  const initial = buildFamilyInput((await readFamilyRows(db)).content); // same six rows (and same reader) as the public section
  return (
    <>
      <h1>Family section</h1>
      <p className="adm-sub">The &ldquo;{FAMILY_DEFAULTS.title}&rdquo; block on the home page: heading, text, closing line, image, and an on/off switch. Changes appear within moments.</p>
      <FamilyEditor initial={initial} />
    </>
  );
}
