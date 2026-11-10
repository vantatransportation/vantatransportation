import ContentEditor, { type ContentRow } from "@/components/admin/ContentEditor";
import { adminPage } from "@/lib/admin/data";
import { configWarnings } from "@/lib/notify";
import { BUSINESS_TZ } from "@/lib/config";

export const metadata = { title: "Settings" };

const ENV: [string, string][] = [
  ["NEXT_PUBLIC_SUPABASE_URL", "Supabase project URL"], ["NEXT_PUBLIC_SUPABASE_ANON_KEY", "Supabase publishable key"], ["SUPABASE_SERVICE_ROLE_KEY", "Supabase service-role key (server only)"],
  ["GOOGLE_MAPS_SERVER_API_KEY", "Google server key (Routes + Places)"], ["NEXT_PUBLIC_GOOGLE_MAPS_API_KEY", "Google browser key (map display)"],
  ["STRIPE_SECRET_KEY", "Stripe secret key (server only; value never shown)"], ["STRIPE_WEBHOOK_SECRET", "Stripe webhook signing secret (server only)"],
  ["NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME", "Cloudinary cloud name"], ["NEXT_PUBLIC_CLOUDINARY_API_KEY", "Cloudinary API key (public identifier)"], ["CLOUDINARY_API_SECRET", "Cloudinary API secret (server only; value never shown)"],
  ["BREVO_API_KEY", "Brevo API key (server only; value never shown)"], ["BREVO_SENDER_EMAIL", "Brevo verified sender email"], ["BREVO_SENDER_NAME", "Email sender name"],
  ["BUSINESS_NOTIFICATION_EMAIL", "Business notification recipient (defaults to the business email)"], ["NEXT_PUBLIC_SITE_URL", "Public site URL (used in links)"],
];

export default async function Settings() {
  const { db, admin } = await adminPage();
  const [{ data: content }, { data: admins }] = await Promise.all([
    db.from("site_content").select("key,label,group_name,value,is_placeholder").eq("group_name", "Settings"),
    db.from("admin_users").select("user_id,email,role").order("created_at"),
  ]);
  const rows: ContentRow[] = ((content ?? []) as { key: string; label: string; group_name: string; value: unknown; is_placeholder: boolean }[]).map((r) => ({
    key: r.key, label: r.label, group_name: r.group_name, is_placeholder: r.is_placeholder, isString: typeof r.value === "string", text: typeof r.value === "string" ? r.value : JSON.stringify(r.value),
  }));
  const warnings = configWarnings();
  return (
    <>
      <h1>Settings</h1>
      <p className="adm-sub">Configuration status. Business phone, email and hours are edited under Website content (Contact). Meet & Greet, waiting time and round-trip discounts have their own pages. Secrets are never displayed; only whether each is set.</p>
      {warnings.map((w) => <div key={w.message} className="banner">{w.message}</div>)}
      <h2>Environment</h2>
      <div className="tbl-wrap"><table className="tbl"><tbody>
        {ENV.map(([k, d]) => <tr key={k}><td><code>{k}</code></td><td>{d}</td><td><span className={`pill ${process.env[k] ? "pill--ok" : "pill--warn"}`}>{process.env[k] ? "Set" : "Not set"}</span></td></tr>)}
        <tr><td><code>BUSINESS_TIMEZONE</code></td><td>Time zone for pickup times</td><td><span className="pill pill--ok">{BUSINESS_TZ}</span></td></tr>
      </tbody></table></div>
      <h2>Notification preferences</h2>
      <p className="adm-sub">Enter <code>true</code> or <code>false</code>. Confirmed, cancelled and no-show emails are always sent to customers; this switch adds every other status change.</p>
      <ContentEditor rows={rows} />
      <h2>Administrators</h2>
      <p className="adm-sub">Admins are added in Supabase (see the README). You are signed in as {admin.email}.</p>
      <div className="tbl-wrap"><table className="tbl"><thead><tr><th>Email</th><th>Role</th></tr></thead><tbody>
        {((admins ?? []) as { user_id: string; email: string; role: string }[]).map((a) => <tr key={a.user_id}><td>{a.email}</td><td>{a.role}</td></tr>)}
      </tbody></table></div>
    </>
  );
}
