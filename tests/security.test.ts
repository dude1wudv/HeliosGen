import { describe, expect, it, beforeEach } from "vitest";
import { randomBytes } from "node:crypto";
import { openSession, sealSession, SESSION_COOKIE } from "@/lib/sub2api/session";
import { getDefaultImageModelId } from "@/lib/modelConfig";
import { assertSafeUrl } from "@/lib/ssrf";

beforeEach(() => {
  process.env.HELIOS_SESSION_SECRET = randomBytes(32).toString("base64");
});

describe("managed session", () => {
  it("seals an authenticated session and rejects tampering", () => {
    const value = sealSession({ userId: "user-a", apiBaseUrl: "https://sub.sunmmyapi.xyz/v1", apiKey: "secret", iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 90 });
    expect(value).not.toContain("secret");
    expect(openSession(value)?.userId).toBe("user-a");
    expect(openSession(`${value}x`)).toBeNull();
    expect(SESSION_COOKIE).toBe("__Host-helios_session");
  });
});

describe("managed contracts", () => {
  it("uses gpt-image-2 as the managed default", () => {
    expect(getDefaultImageModelId(true)).toBe("gpt-image-2");
    expect(getDefaultImageModelId(false)).toBe("nano-banana-2");
  });

  it("rejects credentialed and private URLs", async () => {
    await expect(assertSafeUrl("http://127.0.0.1/admin")).rejects.toThrow();
    await expect(assertSafeUrl("https://user:pass@example.com/image.png")).rejects.toThrow();
  });
});
