import Image from "next/image";
import { hasRealPhoto, photoUrl } from "@/lib/vehicle-photo";

/**
 * A vehicle's photograph, or a branded placeholder when no photo has been assigned yet.
 * The placeholder never shows an illustration of a different vehicle, so nothing is misrepresented.
 */
export default function VehiclePhoto({ src, name, width = 800, height = 500, sizes, priority = false, className = "" }: {
  src: string | null | undefined; name: string; width?: number; height?: number; sizes?: string; priority?: boolean; className?: string;
}) {
  if (!hasRealPhoto(src)) {
    return (
      <div className={`vphoto vphoto--placeholder ${className}`} style={{ aspectRatio: `${width} / ${height}` }} role="img" aria-label={`${name}: photo coming soon`}>
        <span className="vphoto__mark" aria-hidden="true">VANTA</span>
        <span className="vphoto__note">Photo coming soon</span>
      </div>
    );
  }
  return (
    <div className={`vphoto ${className}`} style={{ aspectRatio: `${width} / ${height}` }}>
      <Image src={photoUrl(src, width, height)} alt={`${name}`} width={width} height={height} sizes={sizes ?? "(max-width: 700px) 100vw, 400px"} priority={priority} loading={priority ? undefined : "lazy"} />
    </div>
  );
}
