"use client";

import Link from "next/link";
import Image from "next/image";
import { usePathname } from "next/navigation";
import { useState } from "react";
import NotificationCenter from "./NotificationCenter";
import ThemeToggle from "../ThemeToggle";

const NAV = [
  ["/admin", "Overview"], ["/admin/bookings", "Bookings"], ["/admin/customers", "Customers"], ["/admin/leads", "CRM / Leads"],
  ["/admin/quotes", "Quote requests"], ["/admin/follow-ups", "Follow-ups"], ["/admin/vehicles", "Vehicles"], ["/admin/categories", "Vehicle categories"],
  ["/admin/pricing", "Pricing management"], ["/admin/tiers", "Tier prices & fees"], ["/admin/payments", "Payments"], ["/admin/round-trip", "Round-trip rules"], ["/admin/booking-settings", "Booking settings"], ["/admin/faqs", "FAQs"], ["/admin/promotions", "Promotions"], ["/admin/content", "Website content"],
  ["/admin/standards", "Vehicle standards"], ["/admin/notifications", "Notifications"], ["/admin/settings", "Settings"],
] as const;

export default function AdminSidebar({ email }: { email: string }) {
  const path = usePathname();
  const [open, setOpen] = useState(false);

  async function logout() {
    await fetch("/api/admin/logout", { method: "POST" });
    window.location.assign("/admin/login");
  }

  const active = (href: string) => (href === "/admin" ? path === "/admin" : path === href || path.startsWith(href + "/"));

  return (
    <>
      <div className="adm-top">
        <Link href="/admin" className="brand"><Image src="/brand/vanta-mark.svg" alt="" width={36} height={22} /><span className="brand__name" style={{ fontSize: "1.1rem" }}>VANTA</span></Link>
        <button className="nav-toggle" style={{ display: "block" }} aria-expanded={open} aria-controls="adm-side" aria-label="Menu" onClick={() => setOpen((o) => !o)}><span /></button>
      </div>
      {open && <div className="adm-scrim" onClick={() => setOpen(false)} />}
      <aside id="adm-side" className="adm-side" data-open={open}>
        <Link href="/admin" className="brand" onClick={() => setOpen(false)}>
          <Image src="/brand/vanta-mark.svg" alt="" width={44} height={28} />
          <span className="brand__text"><span className="brand__name" style={{ fontSize: "1.2rem" }}>VANTA</span><span className="brand__sub">ADMIN</span></span>
        </Link>
        <NotificationCenter />
        <ThemeToggle />
        <nav className="adm-nav" aria-label="Admin">
          {NAV.map(([href, text]) => (
            <Link key={href} href={href} aria-current={active(href) ? "page" : undefined} onClick={() => setOpen(false)}>{text}</Link>
          ))}
        </nav>
        <div className="adm-user">
          <span>{email}</span>
          <Link href="/" target="_blank" className="muted" style={{ textDecoration: "underline" }}>View website</Link>
          <button className="btn btn--ghost btn-sm" onClick={logout}>Sign out</button>
        </div>
      </aside>
    </>
  );
}
