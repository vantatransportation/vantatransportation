"use client";

import { useEffect, useRef, useState } from "react";
import { postJson } from "./util";
import { hasRealPhoto, photoUrl } from "@/lib/vehicle-photo";

const TYPES = ["image/jpeg", "image/png", "image/webp"];
const MAX = 8 * 1024 * 1024;

/**
 * Vehicle photo control. Flow: choose a file, preview it locally, upload it straight to Cloudinary with a
 * server-signed request, then save the vehicle form. The API secret never reaches this component.
 */
export default function PhotoField({ id, url, publicId, onChange }: { id: string; url: string; publicId: string; onChange: (url: string, publicId: string) => void }) {
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const unsaved = useRef<string | null>(null); // public id uploaded in this session but not yet saved

  useEffect(() => {
    fetch("/api/admin/cloudinary/sign").then((r) => r.json()).then((d) => setConfigured(Boolean(d.configured))).catch(() => setConfigured(false));
  }, []);
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);

  function choose(f: File | undefined) {
    setMsg(null);
    if (!f) return;
    if (!TYPES.includes(f.type)) return setMsg({ kind: "error", text: "Choose a JPG, PNG or WebP image." });
    if (f.size > MAX) return setMsg({ kind: "error", text: "That image is larger than 8 MB. Choose a smaller one." });
    setFile(f);
    setPreview(URL.createObjectURL(f));
  }
  function cancel() { setFile(null); setPreview(null); setMsg(null); }

  async function discardUnsaved() {
    if (unsaved.current) { await postJson("/api/admin/cloudinary/discard", { publicId: unsaved.current }); unsaved.current = null; }
  }

  async function upload() {
    if (!file) return;
    setBusy(true); setMsg(null);
    try {
      const sig = await postJson("/api/admin/cloudinary/sign", { contentType: file.type, size: file.size });
      if (!sig.ok) throw new Error(String(sig.data.error ?? "Could not start the upload."));
      const d = sig.data as { cloudName: string; apiKey: string; timestamp: number; folder: string; allowed_formats: string; signature: string };
      const fd = new FormData();
      fd.append("file", file); fd.append("api_key", d.apiKey); fd.append("timestamp", String(d.timestamp));
      fd.append("folder", d.folder); fd.append("allowed_formats", d.allowed_formats); fd.append("signature", d.signature);
      const res = await fetch(`https://api.cloudinary.com/v1_1/${d.cloudName}/image/upload`, { method: "POST", body: fd });
      const out = await res.json().catch(() => ({}));
      if (!res.ok || !out.secure_url || !out.public_id) throw new Error(out?.error?.message ?? "Cloudinary rejected the upload.");
      await discardUnsaved(); // a previous unsaved upload in this session is no longer needed
      unsaved.current = out.public_id;
      onChange(out.secure_url, out.public_id);
      setFile(null); setPreview(null);
      setMsg({ kind: "ok", text: "Uploaded. Save the vehicle to publish this photo." });
    } catch (e) {
      setMsg({ kind: "error", text: e instanceof Error ? e.message : "Upload failed." });
    }
    setBusy(false);
  }

  async function remove() {
    if (!window.confirm("Remove this photo? The website will show the branded placeholder after you save.")) return;
    await discardUnsaved();
    onChange("", "");
    setMsg({ kind: "ok", text: "Photo removed. Save the vehicle to apply." });
  }

  const current = hasRealPhoto(url) ? url : null;
  return (
    <div className="photo-field">
      {configured === false && <div className="notice notice--error" role="alert">Photo uploads are not set up. Add NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME, NEXT_PUBLIC_CLOUDINARY_API_KEY and CLOUDINARY_API_SECRET to the server environment (see README).</div>}
      <div className="photo-field__row">
        <figure className="photo-field__frame">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          {preview ? <img src={preview} alt="Preview of the selected photo" /> : current ? <img src={photoUrl(current, 480, 300)} alt="Current vehicle photo" /> : <span className="muted">No photo assigned. A branded placeholder is shown on the website.</span>}
          <figcaption className="muted">{preview ? "Preview (not uploaded yet)" : current ? "Currently assigned" : ""}</figcaption>
        </figure>
        <div className="photo-field__actions">
          {!file && (
            <label className={`btn btn--ghost btn-sm${configured === false ? " is-disabled" : ""}`}>
              {current ? "Replace photo" : "Choose photo"}
              <input id={id} type="file" accept="image/jpeg,image/png,image/webp" hidden disabled={configured === false} onChange={(e) => { choose(e.target.files?.[0]); e.target.value = ""; }} />
            </label>
          )}
          {file && <><button type="button" className="btn btn--primary btn-sm" onClick={upload} disabled={busy}>{busy ? "Uploading…" : "Upload this photo"}</button><button type="button" className="btn btn--ghost btn-sm" onClick={cancel} disabled={busy}>Cancel</button></>}
          {current && !file && <button type="button" className="btn btn--ghost btn-sm" onClick={remove}>Remove photo</button>}
          <span className="help">JPG, PNG or WebP, up to 8 MB. {publicId ? "Stored in Cloudinary." : ""}</span>
        </div>
      </div>
      <div role="status" aria-live="polite">{msg && <div className={`notice notice--${msg.kind}`}>{msg.text}</div>}</div>
    </div>
  );
}
