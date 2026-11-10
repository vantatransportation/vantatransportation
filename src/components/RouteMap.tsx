/* eslint-disable @typescript-eslint/no-explicit-any */
"use client";

import { useEffect, useRef, useState } from "react";
import { decodePolyline } from "@/lib/geo/polyline";

let mapsPromise: Promise<any> | null = null;

function loadMaps(key: string): Promise<any> {
  if (typeof window === "undefined") return Promise.reject(new Error("no window"));
  const w = window as any;
  if (w.google?.maps?.importLibrary) return Promise.resolve(w.google.maps);
  if (!mapsPromise) {
    mapsPromise = new Promise((resolve, reject) => {
      w.__vantaMapsReady = () => resolve(w.google.maps);
      const s = document.createElement("script");
      s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&v=weekly&loading=async&callback=__vantaMapsReady`;
      s.async = true;
      s.onerror = () => { mapsPromise = null; reject(new Error("Google Maps failed to load")); };
      document.head.appendChild(s);
    });
  }
  return mapsPromise;
}

const DARK_STYLE = [
  { elementType: "geometry", stylers: [{ color: "#1b1c1f" }] },
  { elementType: "labels.text.fill", stylers: [{ color: "#9a9ea5" }] },
  { elementType: "labels.text.stroke", stylers: [{ color: "#141517" }] },
  { featureType: "road", elementType: "geometry", stylers: [{ color: "#2e3034" }] },
  { featureType: "water", elementType: "geometry", stylers: [{ color: "#0c0d0e" }] },
  { featureType: "poi", stylers: [{ visibility: "off" }] },
];

export default function RouteMap({ polyline }: { polyline: string | null }) {
  const key = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<any>(null);
  const overlays = useRef<any[]>([]);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (!key || !el.current) return;
    let cancelled = false;
    loadMaps(key)
      .then(async (maps) => {
        if (cancelled || !el.current) return;
        await maps.importLibrary("maps");
        if (!map.current) {
          map.current = new maps.Map(el.current, { center: { lat: 38.9, lng: -77.04 }, zoom: 8, disableDefaultUI: true, zoomControl: true, styles: DARK_STYLE, gestureHandling: "cooperative" });
        }
        overlays.current.forEach((o) => o.setMap(null));
        overlays.current = [];
        if (!polyline) return;
        const path = decodePolyline(polyline).map(([lat, lng]) => ({ lat, lng }));
        if (path.length < 2) return;
        const line = new maps.Polyline({ path, strokeColor: "#d9dbde", strokeOpacity: 0.95, strokeWeight: 4, map: map.current });
        const dot = (pos: any, fill: string) => new maps.Marker({ position: pos, map: map.current, icon: { path: maps.SymbolPath.CIRCLE, scale: 7, fillColor: fill, fillOpacity: 1, strokeColor: "#000", strokeWeight: 2 } });
        overlays.current = [line, dot(path[0], "#ffffff"), dot(path[path.length - 1], "#8d9197")];
        const bounds = new maps.LatLngBounds();
        path.forEach((p) => bounds.extend(p));
        map.current.fitBounds(bounds, 40);
      })
      .catch(() => !cancelled && setError(true));
    return () => { cancelled = true; };
  }, [key, polyline]);

  if (!key || error) {
    return <div className="map map--off" role="img" aria-label="Route map unavailable"><p>{error ? "The map could not be loaded." : "Route map is not configured."} Your route details and fare are shown below.</p></div>;
  }
  return <div ref={el} className="map" role="img" aria-label="Map of your route" />;
}
