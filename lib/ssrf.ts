import dns from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";

const DEFAULT_MAX_BYTES = 30 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;

export interface SafeFetchOptions {
  maxBytes?: number;
  timeoutMs?: number;
  maxRedirects?: number;
  headers?: Record<string, string>;
}

export interface SafeFetchResult {
  buffer: Buffer;
  contentType: string;
  url: string;
}

function blockedIpv4(address: string): boolean {
  const octets = address.split(".").map(Number);
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b] = octets;
  return a === 0 || a === 10 || a === 127 || a === 169 && b === 254 ||
    a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168 ||
    a === 192 && b === 0 || a === 198 && b >= 18 && b <= 19 ||
    a === 100 && b >= 64 && b <= 127 || a === 198 && b === 51 ||
    a === 203 && b === 0 || a >= 224;
}

function blockedIpv6(address: string): boolean {
  const normalized = address.toLowerCase().split("%")[0];
  if (normalized === "::" || normalized === "::1" || normalized.startsWith("ff") ||
      normalized.startsWith("fc") || normalized.startsWith("fd") ||
      normalized.startsWith("fe8") || normalized.startsWith("fe9") ||
      normalized.startsWith("fea") || normalized.startsWith("feb") ||
      normalized.startsWith("2001:db8") || normalized.startsWith("2002:") ||
      normalized.startsWith("64:ff9b:")) return true;
  const words = ipv6Words(normalized);
  if (!words) return true;
  // OS networking treats IPv4-mapped IPv6 as the embedded IPv4 destination.
  // Check the 128-bit form too; DNS commonly returns ::ffff:7f00:1 rather than
  // the dotted ::ffff:127.0.0.1 spelling.
  const mapped = words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff;
  const compatible = words.slice(0, 6).every((word) => word === 0);
  if (!mapped && !compatible) return false;
  const octets = [words[6] >>> 8, words[6] & 0xff, words[7] >>> 8, words[7] & 0xff];
  return blockedIpv4(octets.join("."));
}

function ipv6Words(address: string): number[] | null {
  let value = address;
  if (value.includes(".")) {
    const split = value.lastIndexOf(":");
    if (split < 0) return null;
    const octets = value.slice(split + 1).split(".").map(Number);
    if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null;
    value = `${value.slice(0, split)}:${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`;
  }
  const halves = value.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const raw = halves.length === 2
    ? [...left, ...Array(8 - left.length - right.length).fill("0"), ...right]
    : left;
  if (raw.length !== 8 || raw.some((word) => !/^[0-9a-f]{1,4}$/.test(word))) return null;
  return raw.map((word) => Number.parseInt(word, 16));
}

function blockedAddress(address: string): boolean {
  const family = net.isIP(address);
  return family === 4 ? blockedIpv4(address) : family === 6 ? blockedIpv6(address) : true;
}

async function resolvePublicAddress(hostname: string): Promise<{ address: string; family: 4 | 6 }> {
  const literalFamily = net.isIP(hostname);
  if (literalFamily && blockedAddress(hostname)) throw new Error("URL resolves to a private address");
  const records = literalFamily
    ? [{ address: hostname, family: literalFamily }]
    : await dns.lookup(hostname, { all: true, verbatim: true });
  if (records.length === 0 || records.some(({ address }) => blockedAddress(address))) {
    throw new Error("URL resolves to a private address");
  }
  const first = records[0];
  return { address: first.address, family: first.family as 4 | 6 };
}

export async function assertSafeUrl(value: string, options?: { allowData?: boolean }): Promise<URL> {
  if (options?.allowData && value.startsWith("data:")) return new URL("https://data.invalid/");
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("Invalid URL"); }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Only HTTP(S) URLs are allowed");
  if (url.username || url.password) throw new Error("URL credentials are not allowed");
  await resolvePublicAddress(url.hostname);
  return url;
}

function requestOnce(url: URL, address: { address: string; family: 4 | 6 }, options: Required<Pick<SafeFetchOptions, "maxBytes" | "timeoutMs">> & Pick<SafeFetchOptions, "headers">): Promise<{ status: number; location?: string; buffer: Buffer; contentType: string }> {
  return new Promise((resolve, reject) => {
    const transport = url.protocol === "https:" ? https : http;
    const chunks: Buffer[] = [];
    let total = 0;
    const request = transport.get({
      hostname: address.address,
      port: url.port ? Number(url.port) : undefined,
      path: `${url.pathname}${url.search}`,
      headers: { Host: url.host, ...(options.headers ?? {}) },
      servername: url.hostname,
      lookup: (_hostname, _opts, callback) => callback(null, address.address, address.family),
      timeout: options.timeoutMs,
    }, (response) => {
      const status = response.statusCode ?? 0;
      const location = typeof response.headers.location === "string" ? response.headers.location : undefined;
      if (status >= 300 && status < 400 && location) {
        response.resume();
        resolve({ status, location, buffer: Buffer.alloc(0), contentType: "" });
        return;
      }
      if (status < 200 || status >= 300) {
        response.resume();
        reject(new Error(`Remote request failed (${status})`));
        return;
      }
      response.on("data", (chunk: Buffer) => {
        total += chunk.byteLength;
        if (total > options.maxBytes) {
          request.destroy(new Error("Remote response is too large"));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => resolve({
        status,
        buffer: Buffer.concat(chunks),
        contentType: response.headers["content-type"] ?? "application/octet-stream",
      }));
      response.on("error", reject);
    });
    const totalTimeout = setTimeout(
      () => request.destroy(new Error("Remote request timed out")),
      options.timeoutMs,
    );
    request.on("close", () => clearTimeout(totalTimeout));
    request.on("timeout", () => request.destroy(new Error("Remote request timed out")));
    request.on("error", reject);
  });
}

export async function fetchSafeBuffer(value: string, options: SafeFetchOptions = {}): Promise<SafeFetchResult> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRedirects = options.maxRedirects ?? 5;
  let url = await assertSafeUrl(value);
  for (let redirect = 0; ; redirect++) {
    if (redirect > maxRedirects) throw new Error("Too many redirects");
    const address = await resolvePublicAddress(url.hostname);
    const response = await requestOnce(url, address, { maxBytes, timeoutMs, headers: options.headers });
    if (!response.location) return { buffer: response.buffer, contentType: response.contentType, url: url.toString() };
    const next = new URL(response.location, url);
    if (next.protocol !== "http:" && next.protocol !== "https:" || next.username || next.password) {
      throw new Error("Unsafe redirect");
    }
    url = await assertSafeUrl(next.toString());
  }
}
