"use client";

import Image from "next/image";
import Link from "next/link";
import ThemeToggle from "./ThemeToggle";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { openCalculator } from "@/lib/calculator-events";

const links = [
  { href: "/", label: "Home" },
  { href: "/about", label: "About us" },
  { href: "/rides", label: "Rides we offer" },
  { href: "/quote", label: "Get a quote" },
  { href: "/contact", label: "Contact" },
];

export default function SiteHeader() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    document.body.style.overflow = open ? "hidden" : "";
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = "";
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <header className="header">
      <div className="container header__inner">
        <Link href="/" className="brand" aria-label="Vanta Transportation home">
          <Image src="/brand/vanta-mark.svg" alt="" width={44} height={28} priority />
          <span className="brand__text">
            <span className="brand__name">VANTA</span>
            <span className="brand__sub">TRANSPORTATION</span>
          </span>
        </Link>
        <button
          className="nav-toggle"
          aria-expanded={open}
          aria-controls="main-nav"
          aria-label={open ? "Close menu" : "Open menu"}
          onClick={() => setOpen((o) => !o)}
        >
          <span />
        </button>
        <nav id="main-nav" className="nav" data-open={open} aria-label="Main">
          {links.map((l) => (
            <Link key={l.href} href={l.href} onClick={() => setOpen(false)} aria-current={pathname === l.href ? "page" : undefined}>
              {l.label}
            </Link>
          ))}
          <ThemeToggle />
          <button type="button" className="btn btn--primary" onClick={() => { setOpen(false); openCalculator(); }}>
            BOOK A RIDE
          </button>
        </nav>
      </div>
    </header>
  );
}
