import { isIP } from "node:net";

/**
 * Public-hosted identity mode is deliberately opt-in. The public env flag is
 * included because Next inlines NEXT_PUBLIC_* values into client bundles, while
 * the server-only flag is the authoritative deployment switch.
 */
export const MANAGED_MODE =
  process.env.SUB2API_MANAGED_MODE === "true" ||
  process.env.NEXT_PUBLIC_SUB2API_MANAGED_MODE === "true";

export const HELIOS_PUBLIC_ORIGIN =
  process.env.HELIOS_PUBLIC_ORIGIN ?? "https://canvas.sub.sunmmyapi.xyz";

export function isLoopbackHttpOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    if (url.protocol !== "http:") return false;
    const host = url.hostname;
    return host === "localhost" || host === "[::1]" || host === "::1" ||
      (isIP(host) === 4 && (host === "127.0.0.1" || host.startsWith("127.")));
  } catch {
    return false;
  }
}

export function managedModeEnabled(): boolean {
  return MANAGED_MODE;
}
