import { NextResponse } from "next/server";
import { sameOrigin } from "@/lib/http";
import { ACCESS_COOKIE, REFRESH_COOKIE, cookieOptions } from "@/lib/admin/auth";

export async function POST(request: Request) {
  if (!sameOrigin(request)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const res = NextResponse.json({ ok: true });
  res.cookies.set(ACCESS_COOKIE, "", cookieOptions(0));
  res.cookies.set(REFRESH_COOKIE, "", cookieOptions(0));
  return res;
}
