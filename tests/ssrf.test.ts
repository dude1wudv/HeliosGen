import { describe, expect, it, vi } from "vitest";
import dns from "node:dns/promises";
import http from "node:http";
import { EventEmitter } from "node:events";
import { assertSafeUrl, fetchSafeBuffer } from "@/lib/ssrf";

describe("shared SSRF policy", () => {
  it("rejects credentials and private, loopback, link-local, and metadata addresses", async () => {
    await expect(assertSafeUrl("https://user:pass@example.com/image.png")).rejects.toThrow("credentials");
    await expect(assertSafeUrl("http://127.0.0.1/admin")).rejects.toThrow("private");
    await expect(assertSafeUrl("http://169.254.169.254/latest/meta-data")).rejects.toThrow("private");
    await expect(assertSafeUrl("http://10.0.0.1/internal")).rejects.toThrow("private");
    await expect(assertSafeUrl("ftp://example.com/image.png")).rejects.toThrow("HTTP(S)");
  });

  it("re-resolves every redirect and rejects DNS rebinding to a private address", async () => {
    const lookup = vi.spyOn(dns, "lookup");
    lookup
      .mockResolvedValueOnce([{ address: "93.184.216.34", family: 4 }] as never)
      .mockResolvedValueOnce([{ address: "93.184.216.34", family: 4 }] as never)
      .mockResolvedValueOnce([{ address: "127.0.0.1", family: 4 }] as never);

    const response = Object.assign(new EventEmitter(), {
      statusCode: 302,
      headers: { location: "http://rebinding.example/internal" },
      resume: vi.fn(),
    });
    const request = Object.assign(new EventEmitter(), { destroy: vi.fn() });
    const get = vi.spyOn(http, "get").mockImplementation(((
      _options: unknown,
      callback: (value: typeof response) => void,
    ) => {
      queueMicrotask(() => callback(response));
      return request;
    }) as never);

    await expect(fetchSafeBuffer("http://public.example/image.png", { maxRedirects: 2 })).rejects.toThrow("private");
    expect(get).toHaveBeenCalledTimes(1);
    expect(response.resume).toHaveBeenCalledTimes(1);
    expect(lookup).toHaveBeenCalledTimes(3);
    get.mockRestore();
    lookup.mockRestore();
  });
});
