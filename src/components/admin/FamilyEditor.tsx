"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import PhotoField from "./PhotoField";
import { postJson } from "./util";
import { FAMILY_LIMITS, type FamilyInput } from "@/lib/family-section";

/** Editor for the "Every Passenger Is Family." section. The image is uploaded to Cloudinary (folder vanta/site) with the signed flow. */
export default function FamilyEditor({ initial }: { initial: FamilyInput }) {
  const router = useRouter();
  const [v, setV] = useState<FamilyInput>(initial);
  // Re-sync from the server after router.refresh() (the form then shows what the database holds) without remounting,
  // so the "Saved" message is not wiped. Edits are not touched unless the stored values themselves changed.
  const stored = JSON.stringify(initial);
  const [seen, setSeen] = useState(stored);
  if (stored !== seen) { setSeen(stored); setV(initial); }
  const [state, setState] = useState<{ kind: "idle" | "saving" | "ok" | "error"; text?: string }>({ kind: "idle" });
  const set = <K extends keyof FamilyInput>(k: K, val: FamilyInput[K]) => setV((s) => ({ ...s, [k]: val }));

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setState({ kind: "saving" });
    const { ok, data } = await postJson("/api/admin/family", { content: v });
    if (!ok) return setState({ kind: "error", text: String(data.error ?? "Could not save.") });
    if (data.content) setV(data.content as FamilyInput); // exactly what the database stored
    setState({ kind: "ok", text: data.revalidated === false ? "Saved. The home page may take up to a minute to show the change." : "Saved. The home page shows the change now." });
    router.refresh();
  }

  return (
    <form className="form" onSubmit={save}>
      <div className="field check full"><input id="fs-on" type="checkbox" checked={v.enabled} onChange={(e) => set("enabled", e.target.checked)} /><label htmlFor="fs-on">Show this section on the home page</label></div>
      <div className="field full"><label htmlFor="fs-title">Heading</label><input id="fs-title" value={v.title} maxLength={FAMILY_LIMITS.title} onChange={(e) => set("title", e.target.value)} /></div>
      <div className="field full"><label htmlFor="fs-sub">Subheading</label><input id="fs-sub" value={v.subtitle} maxLength={FAMILY_LIMITS.subtitle} onChange={(e) => set("subtitle", e.target.value)} /></div>
      <div className="field full"><label htmlFor="fs-body">Paragraph</label><textarea id="fs-body" value={v.body} maxLength={FAMILY_LIMITS.body} onChange={(e) => set("body", e.target.value)} style={{ minHeight: 140 }} /></div>
      <div className="field full"><label htmlFor="fs-close">Closing line (bold)</label><input id="fs-close" value={v.closing} maxLength={FAMILY_LIMITS.closing} onChange={(e) => set("closing", e.target.value)} /></div>
      <div className="field full">
        <label htmlFor="fs-img">Image</label>
        <PhotoField id="fs-img" url={v.image.url} publicId={v.image.publicId} purpose="site" onChange={(url, publicId) => set("image", { ...v.image, url, publicId })} />
        <span className="help">A landscape photo (about 16:10, at least 1200 px wide) of passengers and chauffeurs works best. Use a photo you own or have a licence for, with no third-party watermark. Without an image the section shows the Vanta mark.</span>
      </div>
      <div className="field full"><label htmlFor="fs-alt">Image description (for screen readers)</label><input id="fs-alt" value={v.image.alt} maxLength={FAMILY_LIMITS.alt} onChange={(e) => set("image", { ...v.image, alt: e.target.value })} /></div>
      <div className="full actions">
        <button className="btn btn--primary" type="submit" disabled={state.kind === "saving"}>{state.kind === "saving" ? "Saving…" : "Save changes"}</button>
        <span role="status" aria-live="polite" className={state.kind === "error" ? "field__error" : "muted"}>{state.text}</span>
      </div>
    </form>
  );
}
