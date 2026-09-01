import { NextRequest, NextResponse } from "next/server";
import { HELIOS_PUBLIC_ORIGIN } from "@/lib/managedMode";
import { clearSessionCookie } from "@/lib/sub2api/session";

export const runtime = "nodejs";

export async function POST(request: NextRequest): Promise<NextResponse> {
  const origin = request.headers.get("origin");
  if (origin && origin !== HELIOS_PUBLIC_ORIGIN) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const response = NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
  clearSessionCookie(response);
  return response;
}
