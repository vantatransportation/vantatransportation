import { redirect } from "next/navigation";
import DriverLogin from "@/components/driver/DriverLogin";
import { getDriverState } from "@/lib/driver/auth";

export const metadata = { title: "Sign in" };
export const dynamic = "force-dynamic";

export default async function Page() {
  if ((await getDriverState()).status === "ok") redirect("/driver");
  return <><h1>Driver sign in</h1><DriverLogin /></>;
}
