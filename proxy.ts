import { APP_BASE_PATH, logicalAppPath } from "@/lib/appPaths";
import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { GUEST_MODE } from "@/lib/guestMode";
import { HELIOS_PUBLIC_ORIGIN, MANAGED_MODE } from "@/lib/managedMode";
import { readSession } from "@/lib/sub2api/session";

const ANONYMOUS_MANAGED_PATHS = new Set([
  "/bootstrap",
  "/api/integrations/sub2api/bootstrap",
  "/api/health",
]);

function isStaticPath(pathname: string): boolean {
  return pathname.startsWith("/_next/") || ["/favicon.ico", "/HG.svg", "/1.webp", "/2.webp", "/3.webp", "/4.webp", "/legacy-recovery.html"].includes(pathname);
}

function apiUnauthorized(): NextResponse {
  return NextResponse.json(
    { error: "unauthorized", code: "session_required" },
    { status: 401, headers: { "Cache-Control": "no-store" } },
  );
}

export async function proxy(request: NextRequest) {
  if (MANAGED_MODE) {
    const pathname = logicalAppPath(request.nextUrl.pathname);
    if (isStaticPath(pathname) || ANONYMOUS_MANAGED_PATHS.has(pathname) ||
        pathname === "/api/callback" || pathname.startsWith("/api/media/")) {
      return NextResponse.next({ request });
    }

    const session = readSession(request);
    if (!session) {
      if (pathname.startsWith("/api/")) return apiUnauthorized();
      const target = request.nextUrl.clone();
      target.pathname = "/bootstrap";
      target.basePath = APP_BASE_PATH;
      target.search = "?reason=session_expired";
      return NextResponse.redirect(target);
    }

    if (!["GET", "HEAD", "OPTIONS"].includes(request.method) &&
        request.headers.get("origin") !== HELIOS_PUBLIC_ORIGIN) {
      return NextResponse.json(
        { error: "forbidden", code: "origin_required" },
        { status: 403, headers: { "Cache-Control": "no-store" } },
      );
    }
    return NextResponse.next({ request });
  }

  if (GUEST_MODE) return NextResponse.next({ request });

  let supabaseResponse = NextResponse.next({ request });
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          supabaseResponse = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  await supabase.auth.getUser();
  return supabaseResponse;
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|api/callback|api/upload-to-r2).*)",
  ],
};
