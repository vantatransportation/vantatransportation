import type { Resource, Field } from "./resources.ts";

export function slugify(s: string): string {
  return s.toLowerCase().normalize("NFKD").replace(/[^\w\s-]/g, "").trim().replace(/[\s_]+/g, "-").replace(/-+/g, "-").slice(0, 80);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function coerceField(f: Field, raw: unknown): { ok: true; value: unknown } | { ok: false; error: string } {
  const blank = raw === null || raw === undefined || (typeof raw === "string" && raw.trim() === "");
  if (f.type === "bool") return { ok: true, value: raw === true || raw === "true" };
  if (blank) {
    if (f.required) return { ok: false, error: `${f.label} is required.` };
    return { ok: true, value: f.type === "tags" ? [] : null };
  }
  switch (f.type) {
    case "text":
    case "textarea":
    case "image":
    case "photo": {
      // eslint-disable-next-line no-control-regex
      const s = String(raw).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trim().slice(0, f.type === "textarea" ? 8000 : 500);
      if ((f.type === "image" || f.type === "photo") && !(s.startsWith("/") || s.startsWith("https://"))) return { ok: false, error: `${f.label} must be an uploaded image or an https:// address.` };
      return { ok: true, value: s };
    }
    case "number": {
      const n = Number(raw);
      if (!Number.isFinite(n) || n < 0) return { ok: false, error: `${f.label} must be a number of zero or more.` };
      return { ok: true, value: n };
    }
    case "money": {
      const n = Number(raw);
      if (!Number.isFinite(n) || n < 0) return { ok: false, error: `${f.label} must be zero or more.` };
      return { ok: true, value: Math.round(n * 100) };
    }
    case "select": {
      const s = String(raw);
      if (!f.options?.includes(s)) return { ok: false, error: `${f.label} has an invalid value.` };
      return { ok: true, value: s };
    }
    case "datetime": {
      const d = new Date(String(raw));
      if (Number.isNaN(d.getTime())) return { ok: false, error: `${f.label} is not a valid date.` };
      return { ok: true, value: d.toISOString() };
    }
    case "ref": {
      const s = String(raw);
      if (!UUID_RE.test(s)) return { ok: false, error: `${f.label} is invalid.` };
      return { ok: true, value: s };
    }
    case "tags": {
      const list = Array.isArray(raw) ? raw.map(String) : String(raw).split(/[\n,]/);
      return { ok: true, value: list.map((t) => t.trim()).filter(Boolean).slice(0, 40) };
    }
  }
}

/** Validates a write against a resource definition. Only declared fields are accepted. */
export function coerceValues(
  resource: Pick<Resource, "fields">,
  values: Record<string, unknown>,
  partial: boolean,
): { ok: true; data: Record<string, unknown> } | { ok: false; error: string } {
  const data: Record<string, unknown> = {};
  for (const f of resource.fields) {
    if (partial && !(f.name in values)) continue;
    const r = coerceField(f, values[f.name]);
    if (!r.ok) return r;
    data[f.name] = r.value;
  }
  if ("slug" in data && !data.slug && typeof values.name === "string") data.slug = slugify(values.name);
  if (resource.fields.some((f) => f.name === "slug") && !partial && !data.slug) {
    return { ok: false, error: "A name is needed to create the URL slug." };
  }
  return { ok: true, data };
}
