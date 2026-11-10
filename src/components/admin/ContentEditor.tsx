"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { postJson } from "./util";

export interface ContentRow { key: string; label: string; group_name: string; text: string; isString: boolean; is_placeholder: boolean }

function Item({ row }: { row: ContentRow }) {
  const router = useRouter();
  const [val, setVal] = useState(row.text);
  const [state, setState] = useState("");
  async function save() {
    setState("Saving…");
    const { ok, data } = await postJson("/api/admin/content", { key: row.key, value: val });
    setState(ok ? "Saved." : String(data.error ?? "Could not save."));
    if (ok) router.refresh();
  }
  return (
    <div className="panel">
      <div style={{ display: "flex", justifyContent: "space-between", gap: "1rem", flexWrap: "wrap" }}>
        <h3 style={{ fontSize: "1.05rem" }}>{row.label}</h3>
        {row.is_placeholder && <span className="pill pill--warn">Placeholder: replace with your own</span>}
      </div>
      <div className="field">
        <label htmlFor={`c-${row.key}`} className="muted">{row.isString ? "Text" : "Value (JSON)"}</label>
        <textarea id={`c-${row.key}`} value={val} onChange={(e) => setVal(e.target.value)} style={{ minHeight: row.isString && val.length < 80 ? 56 : 140, fontFamily: row.isString ? undefined : "ui-monospace, monospace" }} />
      </div>
      <p style={{ marginTop: ".6rem" }}><button className="btn btn--primary btn-sm" onClick={save}>Save</button> <span className="muted" role="status">{state}</span></p>
    </div>
  );
}

export default function ContentEditor({ rows }: { rows: ContentRow[] }) {
  const groups = [...new Set(rows.map((r) => r.group_name))];
  return (
    <>
      {groups.map((g) => (
        <section key={g}>
          <h2>{g}</h2>
          {rows.filter((r) => r.group_name === g).map((r) => <Item key={r.key} row={r} />)}
        </section>
      ))}
    </>
  );
}
