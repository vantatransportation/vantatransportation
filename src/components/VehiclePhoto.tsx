"use client";

import Image from "next/image";
import { useState } from "react";
import { resolvePhotoSrc, photoUrl } from "@/lib/vehicle-photo";

/**
 * A vehicle's photograph, or a branded placeholder when a photo is genuinely missing or cannot load.
 * Loading order: (1) Next's optimiser, (2) if that fails (for example the host is not in images.remotePatterns on this
 * deployment) the same URL straight from its host, (3) only then the placeholder. A new photo gets a fresh attempt.
 */
export default function VehiclePhoto({ src, name, width = 800, height = 500, sizes, priority = false, className = "" }: {
  src: string | null | undefined; name: string; width?: number; height?: number; sizes?: string; priority?: boolean; className?: string;
}) {
  const resolved = resolvePhotoSrc(src);
  const [state, setState] = useState<{ src: string | null; stage: 0 | 1 | 2 }>({ src: null, stage: 0 });
  const stage = state.src === resolved ? state.stage : 0; // a different src resets to the optimiser
  if (!resolved || stage === 2) {
    return (
      <div className={`vphoto vphoto--placeholder ${className}`} style={{ aspectRatio: `${width} / ${height}` }} role="img" aria-label={`${name}: photo coming soon`}>
        <span className="vphoto__mark" aria-hidden="true">VANTA</span>
        <span className="vphoto__note">Photo coming soon</span>
      </div>
    );
  }
  const fail = () => {
    if (typeof console !== "undefined") console.warn(`[vehicle-photo] ${stage === 0 ? "optimised" : "direct"} load failed for "${name}"`);
    setState({ src: resolved, stage: (stage + 1) as 1 | 2 });
  };
  const url = photoUrl(resolved, width, height);
  // The home page and /rides are server-rendered, so their <img> can finish (or fail) BEFORE React hydrates and attaches
  // onError, and that error event is then never delivered: the card would stay broken instead of trying the next stage.
  // The calculator mounts in the browser, so it never had this gap. On mount, treat an already-failed image as a failure.
  const check = (img: HTMLImageElement | null) => {
    if (img && img.complete && img.naturalWidth === 0 && img.getAttribute("src")) fail();
  };
  return (
    <div className={`vphoto ${className}`} style={{ aspectRatio: `${width} / ${height}` }}>
      <Image key={`${url}:${stage}`} src={url} alt={name} width={width} height={height} sizes={sizes ?? "(max-width: 700px) 100vw, 400px"} priority={priority} loading={priority ? undefined : "lazy"} unoptimized={stage === 1} onError={fail} ref={check} />
    </div>
  );
}
