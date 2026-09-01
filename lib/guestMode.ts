import type { NextRequest } from "next/server";
import { MANAGED_MODE } from "@/lib/managedMode";
import { readSession } from "@/lib/sub2api/session";

export const GUEST_MODE = process.env.GUEST_MODE === "true";
export const GUEST_USER_ID = "guest";

/**
 * All server routes use this resolver so hosted identity can never silently
 * fall back to the desktop guest identity. Supabase remains the non-managed
 * web path.
 */
export async function resolveUserId(req: NextRequest): Promise<string | null> {
  if (MANAGED_MODE) return readSession(req)?.userId ?? null;
  if (GUEST_MODE) return GUEST_USER_ID;
  const { supabaseAdmin } = await import("./supabase/admin");
  const auth = req.headers.get("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) return null;
  const { data } = await supabaseAdmin.auth.getUser(token);
  return data.user?.id ?? null;
}

export async function resolveSession(req: NextRequest) {
  if (!MANAGED_MODE) return null;
  return readSession(req);
}
