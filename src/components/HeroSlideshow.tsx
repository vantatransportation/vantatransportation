"use client";

import { useEffect, useRef, useState } from "react";
import { HERO_SIZES, nextIndex, overlayGradient, type HeroSlideView, type HeroView } from "@/lib/hero";

/** Loads a slide into the browser cache with the same srcset/sizes the visible <img> uses, so the switch is instant. */
function preload(s: HeroSlideView, timeoutMs = 10_000): Promise<boolean> {
  return new Promise((resolve) => {
    const img = new Image();
    let done = false;
    const finish = (ok: boolean) => { if (done) return; done = true; clearTimeout(timer); resolve(ok); };
    const timer = setTimeout(() => finish(false), timeoutMs);
    img.onload = () => finish(true);
    img.onerror = () => finish(false);
    img.sizes = HERO_SIZES;
    if (s.srcSet) img.srcset = s.srcSet;
    img.src = s.src;
  });
}

/**
 * Background slideshow for the hero. It renders ONLY the first slide on the server (a real <img> with high fetch priority);
 * every other slide is downloaded just before it is needed. The layer is absolutely positioned behind the hero content, so it
 * can never shift the layout. Autoplay stops for visitors who prefer reduced motion, while the tab is hidden and (optionally)
 * while the pointer is over the hero.
 */
export default function HeroSlideshow({ view }: { view: HeroView }) {
  const { slides } = view;
  const n = slides.length;
  const root = useRef<HTMLDivElement>(null);
  const failed = useRef<Set<number>>(new Set());
  const [index, setIndex] = useState(0);
  const [prev, setPrev] = useState<number | null>(null);
  const [loaded, setLoaded] = useState<number[]>([0]);
  const [changed, setChanged] = useState(false);
  const [reduced, setReduced] = useState(false);
  const [hidden, setHidden] = useState(false);
  const [hover, setHover] = useState(false);

  // A new slide list (for example in the admin preview) starts again from the first slide.
  const signature = slides.map((s) => s.id + s.src).join("|");
  useEffect(() => { setIndex(0); setPrev(null); setLoaded([0]); setChanged(false); failed.current = new Set(); }, [signature]);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);
  useEffect(() => {
    const onVis = () => setHidden(document.visibilityState === "hidden");
    onVis();
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);
  useEffect(() => {
    const host = root.current?.parentElement;
    if (!host || !view.pauseOnHover) { setHover(false); return; }
    const on = () => setHover(true), off = () => setHover(false);
    host.addEventListener("mouseenter", on);
    host.addEventListener("mouseleave", off);
    return () => { host.removeEventListener("mouseenter", on); host.removeEventListener("mouseleave", off); };
  }, [view.pauseOnHover]);

  const commit = (to: number) => {
    setLoaded((l) => (l.includes(to) ? l : [...l, to]));
    setPrev(index);
    setIndex(to);
    setChanged(true);
  };

  const playing = view.autoplay && n > 1 && !reduced && !hidden && !hover;
  useEffect(() => {
    if (!playing) return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      let cand = nextIndex(index, n, failed.current);
      while (cand !== -1) {
        const ok = loaded.includes(cand) || (await preload(slides[cand]));
        if (cancelled) return;
        if (ok) { commit(cand); return; }
        failed.current.add(cand); // a slide that cannot load is skipped, never shown broken
        cand = nextIndex(index, n, failed.current);
      }
    }, view.intervalMs);
    return () => { cancelled = true; clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, index, n, loaded, view.intervalMs, signature]);

  async function goTo(i: number) {
    if (i === index) return;
    if (!loaded.includes(i) && !(await preload(slides[i]))) return;
    commit(i);
  }

  const style = { "--hero-fade": `${view.fadeMs}ms`, "--hero-zoom": `${view.intervalMs + view.fadeMs}ms` } as React.CSSProperties;
  return (
    <div ref={root} className="hero-ss" data-transition={view.transition} data-changed={changed ? "1" : undefined} style={style}>
      {loaded.filter((i) => i < n).sort((a, b) => a - b).map((i) => {
        const s = slides[i];
        const role = i === index ? "active" : i === prev ? "prev" : "idle";
        return (
          <div key={s.id} className="hero-ss__layer" data-role={role} aria-hidden={role !== "active" ? true : undefined}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={s.src} srcSet={s.srcSet} sizes={s.srcSet ? HERO_SIZES : undefined} alt={s.alt}
              {...(i === 0 ? { fetchPriority: "high" as const, loading: "eager" as const } : { loading: "eager" as const })}
              decoding="async" draggable={false}
            />
          </div>
        );
      })}
      <div className="hero-ss__overlay" style={{ background: overlayGradient(view.overlayOpacity) }} aria-hidden="true" />
      {view.showDots && n > 1 && (
        <div className="hero-ss__dots" role="group" aria-label="Hero background images">
          {slides.map((s, i) => (
            <button key={s.id} type="button" className="hero-ss__dot" aria-label={`Show image ${i + 1} of ${n}`} aria-current={i === index ? "true" : undefined} onClick={() => goTo(i)} />
          ))}
        </div>
      )}
    </div>
  );
}
