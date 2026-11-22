import Link from "next/link";
import ThemeToggle from "./ThemeToggle";
import SocialLinks from "./SocialLinks";
import { text } from "@/lib/content";

export default function SiteFooter({ content }: { content: Record<string, unknown> }) {
  const email = text(content, "contact.email");
  const phone = text(content, "contact.phone");
  const hours = text(content, "contact.hours");
  return (
    <footer className="footer">
      <div className="container">
        <div className="footer__grid">
          <div>
            <h4>Vanta Transportation</h4>
            <p className="muted">{text(content, "footer.tagline", "Chauffeured transportation.")}</p>
            <SocialLinks className="social--footer" />
          </div>
          <div>
            <h4>Explore</h4>
            <ul>
              <li><Link href="/about">About us</Link></li>
              <li><Link href="/rides">Rides we offer</Link></li>
              <li><Link href="/track">Track your ride</Link></li>
              <li><Link href="/contact">Contact</Link></li>
            </ul>
          </div>
          <div>
            <h4>Get in touch</h4>
            <ul>
              {phone && <li><a href={`tel:${phone.replace(/[^\d+]/g, "")}`}>{phone}</a></li>}
              {email && <li><a href={`mailto:${email}`}>{email}</a></li>}
              {hours && <li className="muted">{hours}</li>}
              <li><Link href="/quote">Get a quote</Link></li>
              <li><Link href="/book">Request a booking</Link></li>
            </ul>
          </div>
        </div>
        <ThemeToggle className="theme-toggle--footer" />
        <p className="footer__legal">© {new Date().getFullYear()} Vanta Transportation. Booking and quote requests are not confirmed until we confirm them with you directly.</p>
      </div>
    </footer>
  );
}
