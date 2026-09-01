import { NextRequest, NextResponse } from "next/server";
import { HELIOS_PUBLIC_ORIGIN, MANAGED_MODE } from "@/lib/managedMode";
import { setSessionCookie } from "@/lib/sub2api/session";

export const runtime = "nodejs";

function noStore(response: NextResponse): NextResponse {
  response.headers.set("Cache-Control", "no-store");
  response.headers.set("Pragma", "no-cache");
  return response;
}

function originAllowed(request: NextRequest): boolean {
  const origin = request.headers.get("origin");
  return origin === HELIOS_PUBLIC_ORIGIN || (!origin && request.headers.get("sec-fetch-site") === "same-origin");
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!MANAGED_MODE) return noStore(NextResponse.json({ error: "not_found" }, { status: 404 }));
  if (!originAllowed(request)) {
    return noStore(NextResponse.json({ error: "forbidden" }, { status: 403 }));
  }

  let body: { code?: unknown };
  try {
    body = await request.json();
  } catch {
    return noStore(NextResponse.json({ error: "invalid_grant" }, { status: 400 }));
  }
  if (typeof body.code !== "string" || body.code.length < 16 || body.code.length > 256) {
    return noStore(NextResponse.json({ error: "invalid_grant" }, { status: 400 }));
  }

  const baseUrl = (process.env.SUB2API_INTERNAL_BASE_URL ?? "http://sub2api:8080/api/v1").replace(/\/$/, "");
  const clientId = process.env.HELIOS_WORKBENCH_CLIENT_ID ?? "heliosgen-web";
  const clientSecret = process.env.HELIOS_WORKBENCH_CLIENT_SECRET;
  if (!clientSecret) return noStore(NextResponse.json({ error: "service_unavailable" }, { status: 503 }));

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const upstream = await fetch(`${baseUrl}/workbenches/helios/token`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`, "utf8").toString("base64")}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ code: body.code }),
      cache: "no-store",
      signal: controller.signal,
    });
    if (!upstream.ok) return noStore(NextResponse.json({ error: "invalid_grant" }, { status: 400 }));

    const result = await upstream.json() as {
      user_id?: unknown;
      api_base_url?: unknown;
      api_key?: unknown;
      session_expires_in?: unknown;
    };
    if (
      typeof result.user_id !== "string" || !result.user_id ||
      typeof result.api_base_url !== "string" || !result.api_base_url ||
      typeof result.api_key !== "string" || !result.api_key
    ) return noStore(NextResponse.json({ error: "invalid_grant" }, { status: 400 }));

    const now = Math.floor(Date.now() / 1000);
    const requestedTtl = typeof result.session_expires_in === "number" ? result.session_expires_in : 86_400;
    const ttl = Math.max(1, Math.min(86_400, Math.floor(requestedTtl)));
    const response = noStore(NextResponse.json({ ok: true }));
    setSessionCookie(response, {
      userId: result.user_id,
      apiBaseUrl: result.api_base_url,
      apiKey: result.api_key,
      iat: now,
      exp: now + ttl,
    });
    return response;
  } catch {
    return noStore(NextResponse.json({ error: "service_unavailable" }, { status: 503 }));
  } finally {
    clearTimeout(timeout);
  }
}
