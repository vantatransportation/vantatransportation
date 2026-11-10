import AdminSidebar from "@/components/admin/AdminSidebar";
import { requireAdmin } from "@/lib/admin/auth";

export const dynamic = "force-dynamic";

export default async function PanelLayout({ children }: { children: React.ReactNode }) {
  const admin = await requireAdmin();
  return (
    <div className="adm">
      <AdminSidebar email={admin.email} />
      <main className="adm-main" id="main">{children}</main>
    </div>
  );
}
