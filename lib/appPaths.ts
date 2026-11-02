/** Public, build-time prefix shared by Next, browser requests and media URLs. */
export function normalizeAppBasePath(value: string | undefined): string {
  const path = (value ?? "").replace(/\/+$/, "");
  if (!path) return "";
  if (!/^\/[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/.test(path)) {
    throw new Error("NEXT_PUBLIC_APP_BASE_PATH must be a simple absolute path prefix");
  }
  return path;
}

export const APP_BASE_PATH = normalizeAppBasePath(process.env.NEXT_PUBLIC_APP_BASE_PATH);

/** Prefix local URLs only; remote, blob and data URLs are deliberately untouched. */
export function appPath<T>(value: T): T {
  if (typeof value !== "string" || !APP_BASE_PATH || !value.startsWith("/") || value.startsWith("//")) return value;
  if (value === APP_BASE_PATH || ["/", "?", "#"].some((suffix) => value.startsWith(`${APP_BASE_PATH}${suffix}`))) return value;
  return `${APP_BASE_PATH}${value}` as T;
}

/** Accept both historical root media references and the new public prefix. */
export function logicalAppPath<T>(value: T): T {
  if (typeof value !== "string" || !APP_BASE_PATH) return value;
  if (value === APP_BASE_PATH) return "/" as T;
  return value.startsWith(`${APP_BASE_PATH}/`) ? value.slice(APP_BASE_PATH.length) as T : value;
}

export function appFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return fetch(typeof input === "string" ? appPath(input) : input, init);
}
