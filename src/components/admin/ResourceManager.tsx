"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { ClientResource } from "@/lib/admin/resources";
import FieldsForm from "./FieldsForm";
import { fmtDate, fmtMoney, getPath, label, postJson, type RefOptions, type Row } from "./util";

const STATUS_CLASS: Record<string, string> = {
  confirmed: "pill--ok", completed: "pill--ok", active: "pill--ok", accepted: "pill--ok", converted: "pill--ok", vip: "pill--ok",
  new_request: "pill--warn", new: "pill--warn", pending_confirmation: "pill--warn", draft: "pill--warn", reviewing: "pill--warn", follow_up: "pill--warn", revised_sent: "pill--warn",
  cancelled: "pill--bad", no_show: "pill--bad", rejected: "pill--bad", blocked: "pill--bad", not_interested: "pill--bad", archived: "pill--bad",
};

export default function ResourceManager({ resource, rows, refOptions = {}, tz, createLabel }: { resource: ClientResource; rows: Row[]; refOptions?: RefOptions; tz: string; createLabel?: string }) {
  const router = useRouter();
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState("");
  const [msg, setMsg] = useState("");

  const filterOptions = resource.fields.find((f) => f.name === resource.filterField)?.options;
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return rows.filter((r) => {
      if (filter && getPath(r, resource.filterField ?? "") !== filter) return false;
      if (!needle) return true;
      const paths = resource.searchPaths ?? resource.columns.map((c) => c.path);
      return paths.some((p) => String(getPath(r, p) ?? "").toLowerCase().includes(needle));
    });
  }, [rows, q, filter, resource]);

  async function act(body: Record<string, unknown>, confirmText?: string) {
    if (confirmText && !window.confirm(confirmText)) return;
    const { ok, data } = await postJson("/api/admin/crud", { resource: resource.slug, ...body });
    setMsg(ok ? "" : String(data.error ?? "Action failed."));
    if (ok) router.refresh();
  }

  const cell = (r: Row, c: ClientResource["columns"][number]) => {
    const v = getPath(r, c.path);
    if (c.kind === "bool") return <span className={`pill ${v ? "pill--ok" : ""}`}>{v ? "Yes" : "No"}</span>;
    if (c.kind === "money") return fmtMoney(v);
    if (c.kind === "date") return fmtDate(v, tz);
    if (c.kind === "tags") {
      // A list (for example a vehicle's tiers). An empty list is flagged because the vehicle is then not offered in any tier.
      const list = Array.isArray(v) ? v.map(String) : [];
      return list.length ? <span className="tags">{list.map((t) => <span key={t} className="pill pill--ok">{t}</span>)}</span> : <span className="pill pill--warn" title="Not offered in Calculate Your Fare">None assigned</span>;
    }
    if (c.kind === "status") return v ? <span className={`pill ${STATUS_CLASS[String(v)] ?? ""}`}>{label(String(v))}</span> : null;
    return v == null ? "" : String(v).length > 90 ? String(v).slice(0, 90) + "…" : String(v);
  };

  return (
    <div>
      <div className="toolbar">
        {(resource.searchPaths || resource.columns.length > 0) && (
          <input className="grow" type="search" placeholder={`Search ${resource.title.toLowerCase()}`} aria-label="Search" value={q} onChange={(e) => setQ(e.target.value)} />
        )}
        {filterOptions && (
          <select aria-label="Filter by status" value={filter} onChange={(e) => setFilter(e.target.value)}>
            <option value="">All statuses</option>
            {filterOptions.map((o) => <option key={o} value={o}>{label(o)}</option>)}
          </select>
        )}
        {resource.canCreate && editing !== "new" && (
          <button className="btn btn--primary" onClick={() => setEditing("new")}>{createLabel ?? `Add ${resource.singular}`}</button>
        )}
      </div>

      {msg && <div className="notice notice--error" role="alert">{msg}</div>}

      {editing === "new" && (
        <FieldsForm resource={resource} refOptions={refOptions} tz={tz} onDone={() => setEditing(null)} onCancel={() => setEditing(null)} />
      )}

      <div className="tbl-wrap">
        <table className="tbl">
          <thead>
            <tr>
              {resource.columns.map((c) => <th key={c.path} scope="col">{c.label}</th>)}
              <th scope="col"><span className="sr-only" style={{ position: "absolute", left: -9999 }}>Actions</span></th>
            </tr>
          </thead>
          <tbody>
            {shown.length === 0 && <tr><td colSpan={resource.columns.length + 1} className="muted">Nothing here yet.</td></tr>}
            {shown.map((r) => {
              const id = String(r.id);
              return (
                <FragmentRow key={id}>
                  <tr>
                    {resource.columns.map((c) => <td key={c.path}>{cell(r, c)}</td>)}
                    <td>
                      <div className="row-actions">
                        {resource.sortable && (
                          <>
                            <button className="btn btn--ghost btn-sm" aria-label="Move up" onClick={() => act({ action: "move", id, direction: "up" })}>↑</button>
                            <button className="btn btn--ghost btn-sm" aria-label="Move down" onClick={() => act({ action: "move", id, direction: "down" })}>↓</button>
                          </>
                        )}
                        {resource.rowAction && !r[resource.rowAction.field] && (
                          <button className="btn btn--ghost btn-sm" onClick={() => act({ action: "update", id, values: { [resource.rowAction!.field]: new Date().toISOString() } })}>{resource.rowAction.label}</button>
                        )}
                        {resource.detailHref && <Link className="btn btn--ghost btn-sm" href={resource.detailHref + id}>Open</Link>}
                        {!resource.detailHref && <button className="btn btn--ghost btn-sm" onClick={() => setEditing(editing === id ? null : id)}>{editing === id ? "Close" : "Edit"}</button>}
                        {resource.canDelete && <button className="btn btn--danger btn-sm" onClick={() => act({ action: "delete", id }, `Delete this ${resource.singular}? This cannot be undone.`)}>Delete</button>}
                      </div>
                    </td>
                  </tr>
                  {editing === id && (
                    <tr>
                      <td colSpan={resource.columns.length + 1}>
                        <FieldsForm resource={resource} id={id} initial={r} refOptions={refOptions} tz={tz} onDone={() => setEditing(null)} onCancel={() => setEditing(null)} />
                      </td>
                    </tr>
                  )}
                </FragmentRow>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="muted">{shown.length} of {rows.length} shown</p>
    </div>
  );
}

function FragmentRow({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
