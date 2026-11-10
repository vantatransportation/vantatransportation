"use client";

import Image from "next/image";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { Promotion } from "@/lib/types";

let shownThisPageLoad = false; // "every visit" = once per page load, not on every client-side navigation

const safeUrl = (u: string) => (u.startsWith("/") && !u.startsWith("//") ? u : /^https:\/\//.test(u) ? u : "");

function shouldShow(p: Promotion): boolean {
  try {
    if (!p.showOnMobile && window.matchMedia("(max-width: 720px)").matches) return false;
    const key = `vanta:promo:${p.id}:${p.updatedAt}`;
    const now = Date.now();
    switch (p.frequency) {
      case "every_visit":
        return !shownThisPageLoad;
      case "once_per_session":
        return !sessionStorage.getItem(key);
      case "once_per_day":
      case "once_per_week": {
        const last = Number(localStorage.getItem(key) ?? 0);
        return now - last > (p.frequency === "once_per_day" ? 86_400_000 : 604_800_000);
      }
      case "once":
        return !localStorage.getItem(key);
    }
  } catch {
    return true;
  }
}

function markShown(p: Promotion) {
  shownThisPageLoad = true;
  try {
    const key = `vanta:promo:${p.id}:${p.updatedAt}`;
    if (p.frequency === "once_per_session") sessionStorage.setItem(key, "1");
    else if (p.frequency !== "every_visit") localStorage.setItem(key, String(Date.now()));
  } catch {
    /* storage unavailable: the popup simply may show again */
  }
}

export default function PromoPopup({ promotion }: { promotion: Promotion }) {
  const [open, setOpen] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!shouldShow(promotion)) return;
    const t = setTimeout(() => {
      markShown(promotion);
      setOpen(true);
    }, 1500);
    return () => clearTimeout(t);
  }, [promotion]);

  useEffect(() => {
    if (!open) return;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  if (!open) return null;
  const href = safeUrl(promotion.ctaUrl);
  return (
    <div className="modal-scrim" onClick={() => setOpen(false)}>
      <div className="promo" role="dialog" aria-modal="true" aria-labelledby="promo-title" onClick={(e) => e.stopPropagation()}>
        <button ref={closeRef} className="modal-close" aria-label="Close promotion" onClick={() => setOpen(false)}>×</button>
        {promotion.imageUrl && <Image src={promotion.imageUrl} alt="" width={560} height={280} className="promo__img" unoptimized />}
        <div className="promo__body">
          <h2 id="promo-title">{promotion.title}</h2>
          {promotion.description && <p className="muted">{promotion.description}</p>}
          {promotion.ctaText && href && (
            href.startsWith("/") ? <Link href={href} className="btn btn--primary" onClick={() => setOpen(false)}>{promotion.ctaText}</Link>
              : <a href={href} className="btn btn--primary" target="_blank" rel="noopener noreferrer">{promotion.ctaText}</a>
          )}
        </div>
      </div>
    </div>
  );
}
