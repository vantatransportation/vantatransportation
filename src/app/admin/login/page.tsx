import Image from "next/image";
import { redirect } from "next/navigation";
import LoginForm from "@/components/admin/LoginForm";
import { getAuthState } from "@/lib/admin/auth";
import { getAdminClient } from "@/lib/supabase/admin";

export const metadata = { title: "Sign in" };
export const dynamic = "force-dynamic";

export default async function Login() {
  const configured = Boolean(getAdminClient());
  if (configured && (await getAuthState()).status === "ok") redirect("/admin");
  return (
    <div className="login">
      <div className="login-card">
        <Image src="/brand/vanta-mark.svg" alt="Vanta" width={72} height={45} />
        <h1>Admin sign in</h1>
        {configured ? <LoginForm /> : <div className="notice notice--error">Supabase is not configured. Add the environment variables described in the README, then reload.</div>}
      </div>
    </div>
  );
}
