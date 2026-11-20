import { NextResponse } from "next/server";
import { sameOrigin } from "@/lib/http";
import { DRIVER_ACCESS_COOKIE, DRIVER_REFRESH_COOKIE } from "@/lib/driver/auth";
import { cookieOptions } from "@/lib/admin/auth";

export const runtime = "nodejs";
export async function POST(request: Request) {
  if (!sameOrigin(request)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const res = NextResponse.json({ ok: true });
  res.cookies.set(DRIVER_ACCESS_COOKIE, "", cookieOptions(0));
  res.cookies.set(DRIVER_REFRESH_COOKIE, "", cookieOptions(0));
  return res;
}
