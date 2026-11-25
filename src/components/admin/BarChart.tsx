/** Dependency-free bar chart (inline SVG) with a screen-reader/data table fallback. Values are always the real numbers passed in; null = no data. */
export default function BarChart({ title, data, unit = "", max, decimals = 0 }: { title: string; data: { label: string; value: number | null }[]; unit?: string; max?: number; decimals?: number }) {
  const top = max ?? Math.max(1, ...data.map((d) => d.value ?? 0));
  const W = 560, H = 180, pad = 24, bw = (W - pad * 2) / Math.max(1, data.length);
  const fmt = (v: number) => `${v.toFixed(decimals)}${unit}`;
  return (
    <figure style={{ margin: 0 }}>
      <svg viewBox={`0 0 ${W} ${H + 28}`} role="img" aria-label={`${title}. ${data.map((d) => `${d.label}: ${d.value == null ? "no data" : fmt(d.value)}`).join(", ")}`} style={{ width: "100%", height: "auto", maxHeight: 260 }}>
        <line x1={pad} y1={H} x2={W - pad} y2={H} stroke="currentColor" opacity=".3" />
        {data.map((d, i) => {
          const h = d.value == null ? 0 : Math.max(d.value > 0 ? 2 : 0, (d.value / top) * (H - 24));
          const x = pad + i * bw + bw * 0.18;
          return (
            <g key={d.label}>
              {d.value != null && <rect x={x} y={H - h} width={bw * 0.64} height={h} rx="3" fill="#2dd4bf" />}
              {d.value != null && <text x={x + bw * 0.32} y={H - h - 5} textAnchor="middle" fontSize="11" fill="currentColor">{fmt(d.value)}</text>}
              {d.value == null && <text x={x + bw * 0.32} y={H - 5} textAnchor="middle" fontSize="10" fill="currentColor" opacity=".6">no data</text>}
              <text x={x + bw * 0.32} y={H + 16} textAnchor="middle" fontSize="11" fill="currentColor" opacity=".8">{d.label}</text>
            </g>
          );
        })}
      </svg>
      <figcaption className="muted" style={{ fontSize: ".85rem" }}>{title}</figcaption>
    </figure>
  );
}
