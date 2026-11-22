import Image from "next/image";
import type { FamilyView } from "@/lib/family-section";

/**
 * "Every Passenger Is Family." A dark, bordered card: image on top (stacked, centred text on phones, as in the design), image beside
 * the text from tablet width up. Uses the site's colour tokens so it works in both themes. Without an uploaded image a branded
 * panel is shown. Server component: no client JavaScript.
 */
export default function FamilySection({ view }: { view: FamilyView }) {
  return (
    <section className="section family" id="every-passenger" aria-labelledby="family-title">
      <div className="container">
        <div className="family__card">
          <div className="family__media">
            {view.image ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={view.image.src} srcSet={view.image.srcSet || undefined} sizes="(max-width: 860px) 92vw, 560px" alt={view.image.alt} loading="lazy" decoding="async" width={1200} height={750} />
            ) : (
              <div className="family__fallback" aria-hidden="true"><Image src="/brand/vanta-mark.svg" alt="" width={240} height={150} /></div>
            )}
          </div>
          <div className="family__text">
            <h2 id="family-title" className="family__title">{view.title}</h2>
            {view.subtitle && <p className="family__sub">{view.subtitle}</p>}
            {view.body && <p className="family__body">{view.body}</p>}
            {view.closing && <p className="family__closing">{view.closing}</p>}
          </div>
        </div>
      </div>
    </section>
  );
}
