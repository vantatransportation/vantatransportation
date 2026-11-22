import HeroManager, { type AdminSlide } from "@/components/admin/HeroManager";
import { adminPage } from "@/lib/admin/data";
import { normalizeSettings } from "@/lib/hero";

export const metadata = { title: "Hero slideshow" };

export default async function HeroAdmin() {
  const { db } = await adminPage();
  const [settings, slides] = await Promise.all([
    db.from("hero_settings").select("*").limit(1).maybeSingle(),
    db.from("hero_slides").select("id,image_url,image_public_id,alt_text,sort_order,is_active").order("sort_order").order("created_at"),
  ]);
  const missing = Boolean(settings.error || slides.error);
  if (missing) console.error("[admin/hero] read failed", settings.error?.message ?? slides.error?.message);
  const rows = ((slides.data ?? []) as AdminSlide[]).map((s) => ({ ...s, alt_text: s.alt_text ?? null }));
  const initial = normalizeSettings(settings.data as Record<string, unknown> | null);
  return (
    <>
      <h1>Hero slideshow</h1>
      <p className="adm-sub">Background images for the top of the home page. Upload, order, enable or disable images and choose how they transition. Changes appear on the website within moments, with no code change. Images are stored in Cloudinary (folder vanta/hero); the database keeps only their addresses.</p>
      {missing && <div className="notice notice--error" role="alert">The slideshow tables could not be read. Apply migration <code>supabase/migrations/0011_hero_slideshow_family_section.sql</code> in the Supabase SQL editor, then reload this page.</div>}
      {!missing && <HeroManager key={JSON.stringify([initial, rows.map((r) => [r.id, r.image_url, r.sort_order, r.is_active, r.alt_text])])} initialSettings={initial} initialSlides={rows} />}
    </>
  );
}
