"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import ThemeToggle from "./ThemeToggle";
import { openCalculator } from "@/lib/calculator-events";

// Every destination from the original navigation is kept: Home stays reachable from the logo (and the mobile menu).
const links = [
  { href: "/rides", label: "Rides we offer" },
  { href: "/track", label: "Track Your Ride" },
  { href: "/about", label: "About us" },
  { href: "/quote", label: "Get a quote" },
  { href: "/contact", label: "Contact" },
];

const FOCUSABLE = 'a[href], button:not([disabled]), [role="radio"]:not([disabled]), input:not([disabled])';

/** Compact "Theme" dropdown (disclosure pattern): Escape closes and returns focus, outside click or focus leaving closes it. */
function ThemeMenu() {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const btn = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => { if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { setOpen(false); btn.current?.focus(); } };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("pointerdown", onDown); document.removeEventListener("keydown", onKey); };
  }, [open]);

  return (
    <div className="theme-menu" ref={wrap} onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOpen(false); }}>
      <button ref={btn} type="button" className="theme-menu__btn" aria-expanded={open} aria-controls="theme-menu-panel" onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => { if (e.key === "ArrowDown") { e.preventDefault(); setOpen(true); requestAnimationFrame(() => wrap.current?.querySelector<HTMLElement>('[role="radio"]')?.focus()); } }}>
        Theme <span aria-hidden="true" className="theme-menu__chev">▾</span>
      </button>
      <div id="theme-menu-panel" className="theme-menu__panel" data-open={open}>
        <p className="theme-menu__label" id="theme-menu-label">Appearance</p>
        <ThemeToggle className="theme-toggle--stack" />
      </div>
    </div>
  );
}

export default function SiteHeader() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const toggle = useRef<HTMLButtonElement>(null);
  const nav = useRef<HTMLElement>(null);

  const close = useCallback((returnFocus = false) => { setOpen(false); if (returnFocus) toggle.current?.focus(); }, []);

  // Mobile menu: lock scroll, move focus in, Escape closes (focus returns to the button), Tab stays inside the open menu.
  useEffect(() => {
    document.body.style.overflow = open ? "hidden" : "";
    if (!open) return () => { document.body.style.overflow = ""; };
    requestAnimationFrame(() => nav.current?.querySelector<HTMLElement>("a[href]")?.focus());
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { close(true); return; }
      if (e.key !== "Tab") return;
      const items = [toggle.current, ...Array.from(nav.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])].filter((x): x is HTMLElement => !!x && x.offsetParent !== null);
      if (!items.length) return;
      const first = items[0], last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    const mq = window.matchMedia("(min-width: 861px)");
    const onResize = () => { if (mq.matches) setOpen(false); };
    document.addEventListener("keydown", onKey);
    mq.addEventListener("change", onResize);
    return () => { document.body.style.overflow = ""; document.removeEventListener("keydown", onKey); mq.removeEventListener("change", onResize); };
  }, [open, close]);

  return (
    <header className="header">
      <div className="container header__inner">
        <Link href="/" className="brand" aria-label="Vanta Transportation home" onClick={() => close()}>
          <Image src="/brand/vanta-mark.svg" alt="" width={44} height={28} priority />
          <span className="brand__text">
            <span className="brand__name">VANTA</span>
            <span className="brand__sub">TRANSPORTATION</span>
          </span>
        </Link>
        <button ref={toggle} className="nav-toggle" aria-expanded={open} aria-controls="main-nav" aria-label={open ? "Close menu" : "Open menu"} onClick={() => setOpen((o) => !o)}>
          <span />
        </button>
        <nav ref={nav} id="main-nav" className="nav" data-open={open} aria-label="Main">
          <div className="nav__links">
            <Link href="/" className="nav__home" onClick={() => close()} aria-current={pathname === "/" ? "page" : undefined}>Home</Link>
            {links.map((l) => (
              <Link key={l.href} href={l.href} onClick={() => close()} aria-current={pathname === l.href ? "page" : undefined}>{l.label}</Link>
            ))}
          </div>
          <div className="nav__actions">
            <ThemeMenu />
            <button type="button" className="btn btn--primary nav__cta" onClick={() => { close(); openCalculator(); }}>BOOK A RIDE</button>
          </div>
        </nav>
      </div>
    </header>
  );
}
