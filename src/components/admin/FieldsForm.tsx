"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { ClientResource, Field } from "@/lib/admin/resources";
import PhotoField from "./PhotoField";
import { type Row, type RefOptions, isoToLocalInput, localInputToIso, postJson } from "./util";

type Props = {
  resource: ClientResource;
  /** Existing row id for edits; omit to create. */
  id?: string;
  initial?: Row;
  refOptions?: RefOptions;
  tz: string;
  /** Limit the form to these fields (detail pages). */
  only?: string[];
  /** Values merged into creates (for example customer_id). */
  extra?: Record<string, unknown>;
  submitLabel?: string;
  onDone?: () => void;
  onCancel?: () => void;
};

function initialValue(f: Field, row: Row | undefined, tz: string): string | boolean {
  const v = row?.[f.name];
  if (f.type === "bool") return row ? Boolean(v) : f.name.startsWith("is_") || f.name === "show_on_mobile";
  if (v == null) return f.type === "select" && f.options && !row ? f.options[0] : "";
  if (f.type === "money") return (Number(v) / 100).toFixed(2);
  if (f.type === "datetime") return isoToLocalInput(v, tz);
  if (f.type === "tags") return Array.isArray(v) ? v.join("\n") : "";
  return String(v);
}

export default function FieldsForm({ resource, id, initial, refOptions = {}, tz, only, extra, submitLabel, onDone, onCancel }: Props) {
  const router = useRouter();
  const fields = resource.fields.filter((f) => !f.workflow && (!only || only.includes(f.name)));
  const [vals, setVals] = useState<Record<string, string | boolean>>(() => Object.fromEntries(fields.map((f) => [f.name, initialValue(f, initial, tz)])));
  const [state, setState] = useState<{ kind: "idle" | "saving" | "ok" | "error"; message?: string }>({ kind: "idle" });
  const [uploading, setUploading] = useState<string | null>(null);

  const set = (name: string, v: string | boolean) => setVals((s) => ({ ...s, [name]: v }));

  async function upload(name: string, file: File) {
    setUploading(name);
    const fd = new FormData();
    fd.append("file", file);
    try {
      const res = await fetch("/api/admin/upload", { method: "POST", body: fd });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.url) set(name, data.url);
      else setState({ kind: "error", message: data.error ?? "Upload failed." });
    } catch {
      setState({ kind: "error", message: "Upload failed." });
    }
    setUploading(null);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (state.kind === "saving") return;
    setState({ kind: "saving" });
    const values: Record<string, unknown> = {};
    for (const f of fields) {
      const v = vals[f.name];
      values[f.name] = f.type === "datetime" && typeof v === "string" && v ? localInputToIso(v, tz) : v;
    }
    const body = id
      ? { resource: resource.slug, action: "update", id, values }
      : { resource: resource.slug, action: "create", values: { ...extra, ...values } };
    const { ok, data } = await postJson("/api/admin/crud", body);
    if (!ok) return setState({ kind: "error", message: String(data.error ?? "Could not save.") });
    setState({ kind: "ok", message: "Saved." });
    router.refresh();
    onDone?.();
  }

  return (
    <form className="form" onSubmit={submit} noValidate>
      {fields.map((f) => {
        if (f.hidden) return null;
        const wide = f.type === "textarea" || f.type === "image" || f.type === "photo" || f.type === "tags";
        const cid = `f-${resource.slug}-${f.name}`;
        const v = vals[f.name];
        if (f.type === "bool") {
          return (
            <div key={f.name} className="field check">
              <input id={cid} type="checkbox" checked={Boolean(v)} onChange={(e) => set(f.name, e.target.checked)} />
              <label htmlFor={cid}>{f.label}</label>
              {f.help && <span className="help">{f.help}</span>}
            </div>
          );
        }
        return (
          <div key={f.name} className={`field${wide ? " full" : ""}`}>
            <label htmlFor={cid}>{f.label}{f.required ? " *" : ""}</label>
            {f.type === "textarea" || f.type === "tags" ? (
              <textarea id={cid} value={String(v)} onChange={(e) => set(f.name, e.target.value)} style={{ minHeight: 100 }} />
            ) : f.type === "select" ? (
              <select id={cid} value={String(v)} onChange={(e) => set(f.name, e.target.value)}>
                {f.options?.map((o) => <option key={o} value={o}>{o.replace(/_/g, " ")}</option>)}
              </select>
            ) : f.type === "ref" ? (
              <select id={cid} value={String(v)} onChange={(e) => set(f.name, e.target.value)}>
                <option value="">{f.required ? "Choose…" : "None"}</option>
                {(refOptions[f.ref ?? ""] ?? []).map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
              </select>
            ) : f.type === "photo" ? (
              <PhotoField id={cid} url={String(v)} publicId={String(vals[f.companion ?? ""] ?? "")} onChange={(u, pid) => { set(f.name, u); if (f.companion) set(f.companion, pid); }} />
            ) : f.type === "image" ? (
              <div className="upload">
                {typeof v === "string" && v && (/* eslint-disable-next-line @next/next/no-img-element */ <img src={v} alt="" />)}
                <input id={cid} value={String(v)} onChange={(e) => set(f.name, e.target.value)} placeholder="/path or https:// address" style={{ flex: 1, minWidth: 180 }} />
                <label className="btn btn--ghost btn-sm" style={{ cursor: "pointer" }}>
                  {uploading === f.name ? "Uploading…" : "Upload"}
                  <input type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(e) => e.target.files?.[0] && upload(f.name, e.target.files[0])} />
                </label>
              </div>
            ) : (
              <input
                id={cid}
                type={f.type === "datetime" ? "datetime-local" : f.type === "number" || f.type === "money" ? "number" : "text"}
                step={f.type === "money" ? 0.01 : f.step ?? (f.type === "number" ? 1 : undefined)}
                min={f.type === "number" || f.type === "money" ? 0 : undefined}
                value={String(v)}
                onChange={(e) => set(f.name, e.target.value)}
              />
            )}
            {f.help && <span className="help">{f.help}</span>}
          </div>
        );
      })}
      <div className="full actions">
        <button className="btn btn--primary" type="submit" disabled={state.kind === "saving"}>
          {state.kind === "saving" ? "Saving…" : submitLabel ?? (id ? "Save changes" : "Create")}
        </button>
        {onCancel && <button className="btn btn--ghost" type="button" onClick={onCancel}>Cancel</button>}
        <span role="status" aria-live="polite" className={state.kind === "error" ? "field__error" : "muted"}>{state.message}</span>
      </div>
    </form>
  );
}
