import SiteHeader from "@/components/SiteHeader";
import SiteFooter from "@/components/SiteFooter";
import FloatingActions from "@/components/FloatingActions";
import CalculatorHost from "@/components/CalculatorHost";
import PromoPopup from "@/components/PromoPopup";
import { getSiteData } from "@/lib/content";

export const revalidate = 60;

export default async function SiteLayout({ children }: { children: React.ReactNode }) {
  const site = await getSiteData();
  return (
    <>
      <a className="skip" href="#main">Skip to content</a>
      <SiteHeader />
      <main id="main">{children}</main>
      <SiteFooter content={site.content} />
      <FloatingActions faqs={site.faqs} />
      <CalculatorHost />
      {site.promotion && <PromoPopup promotion={site.promotion} />}
    </>
  );
}
