import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";
import type { NextRequest, NextResponse } from "next/server";
import {
  HELIOS_PUBLIC_ORIGIN,
  MANAGED_MODE,
  isLoopbackHttpOrigin,
} from "@/lib/managedMode";

export const SESSION_COOKIE = "__Host-helios_session";
export const SESSION_VERSION = "v1";
export const SESSION_TTL_SECONDS = 86_400;

export interface Sub2ApiSession {
  v: typeof SESSION_VERSION;
  userId: string;
  apiBaseUrl: string;
  apiKey: string;
  iat: number;
  exp: number;
}

function sessionSecret(): Buffer {
  const value = process.env.HELIOS_SESSION_SECRET ?? "";
  let secret: Buffer;
  try {
    secret = Buffer.from(value, "base64");
  } catch {
    secret = Buffer.alloc(0);
  }
  if (secret.byteLength !== 32) {
    throw new Error("HELIOS_SESSION_SECRET must be a base64-encoded 32-byte secret");
  }
  return secret;
}

// Fail at runtime process/module startup for an enabled hosted deployment. Next
// evaluates route modules while producing a standalone image, where production
// secrets must not be present as build arguments.
if (MANAGED_MODE && process.env.NEXT_PHASE !== "phase-production-build") sessionSecret();

function encoded(value: Buffer): string {
  return value.toString("base64url");
}

function decoded(value: string): Buffer {
  return Buffer.from(value, "base64url");
}

export function sealSession(input: Omit<Sub2ApiSession, "v">): string {
  const payload: Sub2ApiSession = { ...input, v: SESSION_VERSION };
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", sessionSecret(), nonce);
  cipher.setAAD(Buffer.from(SESSION_VERSION, "utf8"));
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(payload), "utf8"),
    cipher.final(),
  ]);
  return [SESSION_VERSION, encoded(nonce), encoded(cipher.getAuthTag()), encoded(ciphertext)].join(".");
}

export function openSession(value: string | undefined | null): Sub2ApiSession | null {
  if (!value) return null;
  try {
    const [version, nonceValue, tagValue, ciphertextValue] = value.split(".");
    if (version !== SESSION_VERSION || !nonceValue || !tagValue || !ciphertextValue) return null;
    const nonce = decoded(nonceValue);
    const tag = decoded(tagValue);
    if (nonce.byteLength !== 12 || tag.byteLength !== 16) return null;
    const decipher = createDecipheriv("aes-256-gcm", sessionSecret(), nonce);
    decipher.setAAD(Buffer.from(version, "utf8"));
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([
      decipher.update(decoded(ciphertextValue)),
      decipher.final(),
    ]).toString("utf8");
    const parsed = JSON.parse(plaintext) as Partial<Sub2ApiSession>;
    const now = Math.floor(Date.now() / 1000);
    if (
      parsed.v !== SESSION_VERSION ||
      typeof parsed.userId !== "string" || parsed.userId.length === 0 ||
      typeof parsed.apiBaseUrl !== "string" ||
      typeof parsed.apiKey !== "string" || parsed.apiKey.length === 0 ||
      typeof parsed.iat !== "number" || typeof parsed.exp !== "number" ||
      !Number.isSafeInteger(parsed.iat) || !Number.isSafeInteger(parsed.exp) ||
      parsed.exp <= now || parsed.iat > now + 60 || parsed.exp - parsed.iat > SESSION_TTL_SECONDS
    ) return null;
    return parsed as Sub2ApiSession;
  } catch {
    return null;
  }
}

export function readSession(request: NextRequest | Request): Sub2ApiSession | null {
  const prefix = `${SESSION_COOKIE}=`;
  const pair = (request.headers.get("cookie") ?? "").split(";").find((part) => part.trimStart().startsWith(prefix));
  const value = pair?.trimStart().slice(prefix.length);
  return openSession(value ? decodeURIComponent(value) : null);
}

function secureCookie(): boolean {
  if (process.env.NODE_ENV === "production") return true;
  return !isLoopbackHttpOrigin(HELIOS_PUBLIC_ORIGIN);
}

export function setSessionCookie(response: NextResponse, session: Omit<Sub2ApiSession, "v">): void {
  response.cookies.set({
    name: SESSION_COOKIE,
    value: sealSession(session),
    httpOnly: true,
    secure: secureCookie(),
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  });
}

export function clearSessionCookie(response: NextResponse): void {
  response.cookies.set({
    name: SESSION_COOKIE,
    value: "",
    httpOnly: true,
    secure: secureCookie(),
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
}
