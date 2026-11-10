import ContentEditor, { type ContentRow } from "@/components/admin/ContentEditor";
import { adminPage } from "@/lib/admin/data";

export const metadata = { title: "Website content" };

export default async function Content() {
  const { db } = await adminPage();
  const { data } = await db.from("site_content").select("key,label,group_name,value,is_placeholder").neq("group_name", "Settings").order("group_name").order("key");
  const rows: ContentRow[] = ((data ?? []) as { key: string; label: string; group_name: string; value: unknown; is_placeholder: boolean }[]).map((r) => ({
    key: r.key, label: r.label, group_name: r.group_name, is_placeholder: r.is_placeholder,
    isString: typeof r.value === "string", text: typeof r.value === "string" ? r.value : JSON.stringify(r.value, null, 2),
  }));
  return (
    <>
      <h1>Website content</h1>
      <p className="adm-sub">Edit headings, descriptions, button labels, contact details and the footer. Items marked as placeholders are sample copy; saving an item removes the placeholder mark. Changes appear on the site within about a minute.</p>
      <ContentEditor rows={rows} />
    </>
  );
}
