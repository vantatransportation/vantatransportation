"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import HeroSlideshow from "@/components/HeroSlideshow";
import PhotoField from "./PhotoField";
import { postJson } from "./util";
import { LIMITS, MAX_HERO_SLIDES, buildHeroView, moveItem, type HeroSettings, type HeroSlideRow } from "@/lib/hero";

export interface AdminSlide { id: string; image_url: string; image_public_id: string; alt_text: string | null; sort_order: number; is_active: boolean }
type Msg = { kind: "ok" | "error"; text: string } | null;

/** The page remounts this component (key) whenever the saved data changes, so local state always starts from the saved values. */
export default function HeroManager({ initialSettings, initialSlides }: { initialSettings: HeroSettings; initialSlides: AdminSlide[] }) {
  const router = useRouter();
  const [settings, setSettings] = useState<HeroSettings>(initialSettings);
  const [slides, setSlides] = useState<AdminSlide[]>(initialSlides);
  const [msg, setMsg] = useState<Msg>(null);
  const [busy, setBusy] = useState(false);
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [addKey, setAddKey] = useState(0);

  async function call(body: Record<string, unknown>, success?: string): Promise<boolean> {
    setBusy(true); setMsg(null);
    const { ok, data } = await postJson("/api/admin/hero", body);
    setBusy(false);
    if (!ok) { setMsg({ kind: "error", text: String(data.error ?? "Could not save.") }); return false; }
    if (success) setMsg({ kind: "ok", text: success });
    router.refresh();
    return true;
  }

  const saveSettings = (e: React.FormEvent) => { e.preventDefault(); void call({ action: "save_settings", settings }, "Settings saved. The website updates within moments."); };
  const setS = <K extends keyof HeroSettings>(k: K, v: HeroSettings[K]) => setSettings((s) => ({ ...s, [k]: v }));
  const num = (k: "fadeMs" | "intervalMs" | "overlayOpacity", v: string) => setS(k, v === "" ? 0 : Number(v));

  async function reorder(from: number, to: number) {
    if (from === to) return;
    const next = moveItem(slides, from, to);
    const before = slides;
    setSlides(next);
    if (!(await call({ action: "reorder", ids: next.map((s) => s.id) }, "Order saved."))) setSlides(before);
  }

  const previewRows: HeroSlideRow[] = slides.map((s) => ({ id: s.id, image_url: s.image_url, image_public_id: s.image_public_id, alt_text: s.alt_text, sort_order: s.sort_order, is_active: s.is_active }));
  const view = useMemo(() => buildHeroView(settings, previewRows), [settings, slides]); // eslint-disable-line react-hooks/exhaustive-deps
  const activeCount = slides.filter((s) => s.is_active).length;

  return (
    <div className="hero-admin">
      {msg && <div className={`notice notice--${msg.kind}`} role={msg.kind === "error" ? "alert" : "status"}>{msg.text}</div>}

      <section className="panel" aria-labelledby="hero-prev">
        <h2 id="hero-prev" style={{ fontSize: "1.2rem" }}>Preview</h2>
        <p className="muted">Shows your slides in the saved order with the settings below (including changes you have not saved yet). Disabled slides are not shown.</p>
        <div className="hero-preview hero hero--media" aria-label="Hero preview">
          {view ? <HeroSlideshow key={JSON.stringify([view.transition, view.fadeMs, view.intervalMs, view.overlayOpacity, view.autoplay, view.showDots, view.slides.map((s) => s.id + s.src)])} view={view} /> : <div className="hero-preview__empty">No active images. The website shows the standard dark hero.</div>}
          <div className="hero-preview__text"><strong>Chauffeured travel, handled properly.</strong><span>Sample hero text, to check readability.</span></div>
        </div>
      </section>

      <form className="form" onSubmit={saveSettings}>
        <h2 className="full" style={{ fontSize: "1.2rem" }}>Slideshow settings</h2>
        <div className="field check"><input id="hs-auto" type="checkbox" checked={settings.autoplay} onChange={(e) => setS("autoplay", e.target.checked)} /><label htmlFor="hs-auto">Play automatically</label><span className="help">When off, the first active image stays on screen (visitors can still use the dots, if shown).</span></div>
        <div className="field"><label htmlFor="hs-tr">Transition style</label>
          <select id="hs-tr" value={settings.transition} onChange={(e) => setS("transition", e.target.value as HeroSettings["transition"])}>
            <option value="fade">Fade</option><option value="slide">Slide</option><option value="zoom">Fade with slow zoom</option>
          </select></div>
        <div className="field"><label htmlFor="hs-fade">Fade duration (milliseconds)</label>
          <input id="hs-fade" type="number" min={LIMITS.fadeMs[0]} max={LIMITS.fadeMs[1]} step={100} value={settings.fadeMs} onChange={(e) => num("fadeMs", e.target.value)} />
          <span className="help">{LIMITS.fadeMs[0]} to {LIMITS.fadeMs[1]}. 1200 is a gentle fade.</span></div>
        <div className="field"><label htmlFor="hs-int">Time each image stays visible (milliseconds)</label>
          <input id="hs-int" type="number" min={LIMITS.intervalMs[0]} max={LIMITS.intervalMs[1]} step={500} value={settings.intervalMs} onChange={(e) => num("intervalMs", e.target.value)} />
          <span className="help">{LIMITS.intervalMs[0]} to {LIMITS.intervalMs[1]}; at least as long as the fade. 6000 = 6 seconds.</span></div>
        <div className="field"><label htmlFor="hs-ov">Overlay darkness (0 to 90)</label>
          <input id="hs-ov" type="number" min={LIMITS.overlayOpacity[0]} max={LIMITS.overlayOpacity[1]} step={5} value={settings.overlayOpacity} onChange={(e) => num("overlayOpacity", e.target.value)} />
          <span className="help">A dark gradient over the photos keeps the heading and buttons readable. Higher is darker.</span></div>
        <div className="field check"><input id="hs-hover" type="checkbox" checked={settings.pauseOnHover} onChange={(e) => setS("pauseOnHover", e.target.checked)} /><label htmlFor="hs-hover">Pause while the pointer is over the hero</label></div>
        <div className="field check"><input id="hs-dots" type="checkbox" checked={settings.showDots} onChange={(e) => setS("showDots", e.target.checked)} /><label htmlFor="hs-dots">Show navigation dots</label></div>
        <div className="full actions"><button className="btn btn--primary" type="submit" disabled={busy}>{busy ? "Saving…" : "Save settings"}</button>
          <span className="muted">Visitors who prefer reduced motion always see a still image.</span></div>
      </form>

      <section className="panel" aria-labelledby="hero-slides">
        <h2 id="hero-slides" style={{ fontSize: "1.2rem" }}>Images ({activeCount} active of {slides.length})</h2>
        <p className="muted">Drag to reorder, or use the arrows. Images play top to bottom. Wide, high-resolution landscape photos (at least 1920 px) work best; JPG, PNG or WebP up to 8 MB. Only the first image loads with the page; the others load just before they appear. With no active images the website keeps its standard hero.</p>
        <ol className="hero-list">
          {slides.map((s, i) => (
            <li key={s.id} className={`hero-item${s.is_active ? "" : " is-off"}${dragFrom === i ? " is-drag" : ""}`} draggable
              onDragStart={() => setDragFrom(i)} onDragEnd={() => setDragFrom(null)} onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => { e.preventDefault(); const from = dragFrom; setDragFrom(null); if (from !== null) void reorder(from, i); }}>
              <span className="hero-item__grip" aria-hidden="true" title="Drag to reorder">⠿</span>
              <div className="hero-item__body">
                <div className="hero-item__top">
                  <strong>Image {i + 1}</strong>
                  <span className={`pill ${s.is_active ? "pill--ok" : ""}`}>{s.is_active ? "Shown" : "Disabled"}</span>
                </div>
                <PhotoField id={`hero-replace-${s.id}`} url={s.image_url} publicId={s.image_public_id} purpose="hero" allowRemove={false}
                  onChange={(url, pid) => { if (url && pid) void call({ action: "replace_slide", id: s.id, url, publicId: pid }, "Image replaced."); }} />
                <AltText key={`${s.id}:${s.alt_text ?? ""}`} slide={s} onSave={(alt) => call({ action: "update_slide", id: s.id, alt }, "Description saved.")} />
                <div className="hero-item__actions">
                  <button type="button" className="btn btn--ghost btn-sm" disabled={i === 0 || busy} onClick={() => void reorder(i, i - 1)} aria-label={`Move image ${i + 1} up`}>↑</button>
                  <button type="button" className="btn btn--ghost btn-sm" disabled={i === slides.length - 1 || busy} onClick={() => void reorder(i, i + 1)} aria-label={`Move image ${i + 1} down`}>↓</button>
                  <button type="button" className="btn btn--ghost btn-sm" disabled={busy} onClick={() => void call({ action: "update_slide", id: s.id, isActive: !s.is_active }, s.is_active ? "Image disabled." : "Image enabled.")}>{s.is_active ? "Disable" : "Enable"}</button>
                  <button type="button" className="btn btn--danger btn-sm" disabled={busy} onClick={() => { if (window.confirm("Remove this image from the slideshow? It is also deleted from Cloudinary unless it is used elsewhere.")) void call({ action: "remove_slide", id: s.id }, "Image removed."); }}>Remove</button>
                </div>
              </div>
            </li>
          ))}
          {slides.length === 0 && <li className="muted">No images yet. Add your first one below.</li>}
        </ol>
        {slides.length < MAX_HERO_SLIDES ? (
          <div className="hero-add">
            <h3 style={{ fontSize: "1.05rem" }}>Add an image</h3>
            <PhotoField key={addKey} id="hero-add" url="" publicId="" purpose="hero" allowRemove={false}
              onChange={(url, pid) => { if (url && pid) void call({ action: "add_slide", url, publicId: pid }, "Image added.").then((ok) => { if (ok) setAddKey((k) => k + 1); }); }} />
          </div>
        ) : <p className="muted">The limit of {MAX_HERO_SLIDES} images is reached.</p>}
      </section>
    </div>
  );
}

function AltText({ slide, onSave }: { slide: AdminSlide; onSave: (alt: string) => Promise<boolean> }) {
  const [alt, setAlt] = useState(slide.alt_text ?? "");
  return (
    <div className="field" style={{ marginTop: ".5rem" }}>
      <label htmlFor={`alt-${slide.id}`}>Description (for screen readers, optional)</label>
      <div className="upload">
        <input id={`alt-${slide.id}`} value={alt} maxLength={200} onChange={(e) => setAlt(e.target.value)} style={{ flex: 1, minWidth: 180 }} />
        <button type="button" className="btn btn--ghost btn-sm" disabled={alt === (slide.alt_text ?? "")} onClick={() => void onSave(alt)}>Save description</button>
      </div>
    </div>
  );
}
