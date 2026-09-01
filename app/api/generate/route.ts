import { NextRequest, NextResponse } from "next/server";
import https from "node:https";
import { spawn } from "node:child_process";
import { writeFile, unlink, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { jobStore } from "@/lib/jobStore";
import { pollKieJob } from "@/lib/kieJobPoller";
import { ensureKieReachableImages } from "@/lib/kieUpload";
import { ensureR2, uploadBuffer } from "@/lib/r2";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { IMAGE_MODELS, validateAzureCustomSize, getDefaultImageModelId } from "@/lib/modelConfig";
import { getKieTokenForUser } from "@/lib/getKieToken";
import { getAzureKeyForUser } from "@/lib/getAzureKey";
import { GUEST_MODE, resolveUserId } from "@/lib/guestMode";
import { HELIOS_PUBLIC_ORIGIN, MANAGED_MODE } from "@/lib/managedMode";
import { readSession } from "@/lib/sub2api/session";
import { generateSub2ApiImage } from "@/lib/sub2api/images";
import { createKieCallbackUrl } from "@/lib/mediaSignature";
import { fetchSafeBuffer } from "@/lib/ssrf";
import { readManagedMediaAsset } from "@/lib/managedMedia";
import * as guestDb from "@/lib/guest/db";

const BASE   = "https://api.kie.ai";
const CREATE = `${BASE}/api/v1/jobs/createTask`;

/**
 * A minimal HTTPS POST that uses Node.js core — NOT Next.js's patched `fetch`.
 * Next.js ties its patched fetch to the request's AbortSignal, which cancels
 * any pending calls when the HTTP response commits. This helper is immune to
 * that because it goes through the raw TLS stack.
 */
function httpsPost(
  url: string,
  headers: Record<string, string>,
  body: string,
  timeoutMs = 1_000_000, // Azure image gen (gpt-image-2) can be slow; 1000s gives ample headroom
): Promise<{ ok: boolean; status: number; text: () => Promise<string> }> {
  return new Promise((resolve, reject) => {
    const u       = new URL(url);
    const bodyBuf = Buffer.from(body, "utf8");

    const req = https.request(
      {
        hostname: u.hostname,
        port:     u.port ? Number(u.port) : 443,
        path:     u.pathname + u.search,
        method:   "POST",
        headers:  { ...headers, "Content-Length": bodyBuf.byteLength },
      },
      (res) => {
        const chunks: Buffer[] = [];

        // Response stream errors (e.g. ECONNRESET mid-body) must be caught here
        res.on("error", reject);
        res.on("data",  (c: Buffer) => chunks.push(c));
        res.on("end",   () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          resolve({
            ok:     (res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 300,
            status: res.statusCode ?? 0,
            text:   () => Promise.resolve(raw),
          });
        });
      },
    );

    // Disable Nagle and keep-alive so the socket stays alive for long responses
    req.on("socket", (socket) => {
      socket.setNoDelay(true);
      socket.setKeepAlive(true, 10_000);
      socket.setTimeout(timeoutMs, () => {
        req.destroy(new Error(`Azure request timed out after ${timeoutMs / 1000}s`));
      });
    });

    req.on("error", reject);
    req.write(bodyBuf);
    req.end();
  });
}

// Resolve remote references through the shared DNS, redirect, timeout, and
// response-size policy. Local media URLs are resolved by the Sub2API adapter.
async function fetchBuffer(url: string, userId: string): Promise<Buffer> {
  if (url.startsWith("/api/media/")) {
    const id = url.slice("/api/media/".length).split(/[?#/]/, 1)[0];
    const asset = id ? guestDb.getMediaAsset(id, userId) : null;
    if (!asset) throw new Error("Media asset is not available");
    return readManagedMediaAsset(asset, 30 * 1024 * 1024);
  }
  const fetched = await fetchSafeBuffer(url, { maxBytes: 30 * 1024 * 1024, timeoutMs: 15_000 });
  return fetched.buffer;
}


// Send a multipart/form-data request via curl (bypasses Node.js TLS quirks with Azure)
async function curlMultipartPost(
  url:        string,
  authKey:    string,
  images:     Array<{ buf: Buffer; mime: string; ext: string }>,
  textFields: Record<string, string>,
): Promise<{ ok: boolean; status: number; body: string }> {
  const tmpFiles: string[] = [];
  const bodyPath = join(tmpdir(), `azure-resp-${Date.now()}.json`);

  try {
    for (const img of images) {
      const p = join(tmpdir(), `azure-img-${Date.now()}-${Math.random().toString(36).slice(2)}.${img.ext}`);
      await writeFile(p, img.buf);
      tmpFiles.push(p);
    }

    const args = [
      "-s", "-m", "600",
      "-X", "POST", url,
      "-H", `Authorization: Bearer ${authKey}`,
      "-o", bodyPath,
      "-w", "%{http_code}",
    ];
    for (let i = 0; i < images.length; i++) {
      args.push("-F", `image[]=@${tmpFiles[i]};type=${images[i].mime}`);
    }
    for (const [k, v] of Object.entries(textFields)) {
      args.push("-F", `${k}=${v}`);
    }

    console.log("[azure/edits/curl] args:", args.map((a) => (a.startsWith("Bearer ") ? "Bearer ***" : a)));

    const runCurl = () => new Promise<{ statusStr: string; stderr: string; exitCode: number }>((resolve, reject) => {
      let out = "";
      let err = "";
      const proc = spawn("curl", args);
      proc.stdout.on("data", (d: Buffer) => out += d.toString());
      proc.stderr.on("data", (d: Buffer) => err += d.toString());
      proc.on("close",  (code) => resolve({ statusStr: out.trim(), stderr: err, exitCode: code ?? -1 }));
      proc.on("error",  (e) => reject(new Error(`curl spawn failed: ${e.message}`)));
    });

    let statusStr: string = "", stderr: string = "", exitCode: number = -1;
    for (let attempt = 1; attempt <= 3; attempt++) {
      ({ statusStr, stderr, exitCode } = await runCurl());
      console.log(`[azure/edits/curl] attempt ${attempt} exit code:`, exitCode);
      if (stderr) console.log("[azure/edits/curl] stderr:", stderr);
      if (exitCode !== 35) break; // 35 = SSL handshake failure — retry
      if (attempt < 3) await new Promise((r) => setTimeout(r, 1000 * attempt));
    }

    if (exitCode! !== 0) {
      const reason = exitCode! === 28 ? "timed out (curl -m 600 exceeded)" : `curl exited with code ${exitCode}`;
      throw new Error(`Azure curl request failed: ${reason}`);
    }

    const status = parseInt(statusStr, 10) || 0;
    const body   = await readFile(bodyPath, "utf-8").catch(() => "");
    console.log("[azure/edits/curl] status:", status, "body:", body.slice(0, 1000));
    return { ok: status >= 200 && status < 300, status, body };
  } finally {
    for (const f of [...tmpFiles, bodyPath]) unlink(f).catch(() => {});
  }
}

// Resolve references to server storage. Hosted media URLs are translated to
// their owner-checked object before any provider receives them.
async function resolveImages(imageUrls: string[], userId?: string): Promise<string[]> {
  const resolved = await Promise.all(
    imageUrls.slice(0, 16).map((url) => ensureR2(url, "references", userId).catch(() => null)),
  );
  return resolved.filter((url): url is string => url !== null);
}

// codex-imagegen (https://github.com/jdmnk/codex-imagegen-cli) only accepts these four sizes.
const CODEX_SIZE_MAP: Record<string, string> = {
  auto:   "auto",
  "1:1":  "1024x1024",
  "16:9": "1536x1024",
  "9:16": "1024x1536",
  "4:3":  "1536x1024",
  "3:4":  "1024x1536",
};

/**
 * codex-imagegen's stderr wraps the underlying failure as `codex-imagegen exited
 * with code N: <tmp path> Error: <detail>`, where <detail> is either a JSON blob
 * (e.g. `HTTP 429: {"error":{"message":"..."}}`) or plain prose terminated by a
 * semicolon (e.g. `Responses stream ended without an image result; last status
 * was failed.`). Pull out just the useful part instead of showing the whole dump.
 */
function cleanCodexError(raw: string): string {
  const match = raw.match(/Error:\s*([\s\S]*)$/);
  const tail = (match ? match[1] : raw).trim();

  const braceIdx = tail.indexOf("{");
  if (braceIdx !== -1) {
    try {
      const parsed = JSON.parse(tail.slice(braceIdx));
      const message = parsed?.error?.message;
      if (typeof message === "string" && message) return message;
    } catch { /* not valid JSON — fall through */ }
  }

  const semiIdx = tail.indexOf(";");
  return (semiIdx !== -1 ? tail.slice(0, semiIdx).trim() : tail) || raw;
}

/**
 * Runs the `codex-imagegen` CLI, which drives OpenAI Codex's image tool using the
 * server's local `codex login` session (~/.codex/auth.json) — a single shared
 * identity for the whole deployment, not a per-user API key. Writes reference
 * images to temp files (the CLI takes file paths, not URLs) and reads the
 * generated PNG back from its --out path.
 */
async function runCodexImagegen(opts: {
  prompt: string;
  images: Array<{ buf: Buffer; ext: string }>;
  size: string;
}): Promise<Buffer> {
  const tmpFiles: string[] = [];
  const outPath = join(tmpdir(), `codex-out-${Date.now()}-${Math.random().toString(36).slice(2)}.png`);

  try {
    const imagePaths: string[] = [];
    for (const img of opts.images) {
      const p = join(tmpdir(), `codex-in-${Date.now()}-${Math.random().toString(36).slice(2)}.${img.ext}`);
      await writeFile(p, img.buf);
      tmpFiles.push(p);
      imagePaths.push(p);
    }

    const args = imagePaths.length > 0
      ? ["edit", ...imagePaths.flatMap((p) => ["--image", p]), "--prompt", opts.prompt, "--size", opts.size, "--out", outPath, "--force"]
      : ["generate", "--prompt", opts.prompt, "--size", opts.size, "--out", outPath, "--force"];

    const { exitCode, stderr } = await new Promise<{ exitCode: number; stderr: string }>((resolve, reject) => {
      let err = "";
      const proc = spawn("codex-imagegen", args);
      proc.stderr.on("data", (d: Buffer) => err += d.toString());
      proc.on("close", (code) => resolve({ exitCode: code ?? -1, stderr: err }));
      proc.on("error", (e) => reject(new Error(`codex-imagegen spawn failed: ${e.message} — is it installed and on PATH?`)));
    });

    if (exitCode !== 0) {
      throw new Error(`codex-imagegen exited with code ${exitCode}: ${stderr.slice(0, 500) || "no stderr output"}`);
    }

    return await readFile(outPath);
  } finally {
    for (const f of [...tmpFiles, outPath]) unlink(f).catch(() => {});
  }
}

export const maxDuration = 1000;

export async function POST(req: NextRequest) {
  const {
    model       = getDefaultImageModelId(),
    prompt,
    imageUrls   = [],
    aspectRatio = "1:1",
    quality     = "1k",
    azureQuality,
    azureResolution,
    azureBaseUrl,
    azureDeployment,
    azureCustomWidth,
    azureCustomHeight,
    codexProvider,
    debugOnly,
  } = (await req.json()) as {
    model?:              string;
    prompt?:             string;
    imageUrls?:          string[];
    aspectRatio?:        string;
    quality?:            string;
    azureQuality?:       string;     // "auto" | "low" | "medium" | "high"
    azureResolution?:    string;     // "1k" | "2k" | "4k"
    azureBaseUrl?:       string;     // global base URL from settings
    azureDeployment?:    string;     // per-model deployment name from settings
    azureCustomWidth?:   number;     // manual size — used when aspectRatio === "custom"
    azureCustomHeight?:  number;
    codexProvider?:      boolean;    // route through the server's local codex-imagegen CLI
    debugOnly?:          boolean;
  };

  if (MANAGED_MODE && codexProvider) {
    return NextResponse.json({ error: "provider_unavailable", code: "provider_unavailable" }, { status: 403 });
  }

  if (debugOnly) {
    const body = { model, prompt, imageUrls, aspectRatio, quality, azureQuality, azureResolution, azureCustomWidth, azureCustomHeight };
    console.log("[DEBUG] generate payload:", JSON.stringify(body, null, 2));
    return NextResponse.json({ ok: true });
  }

  if (!prompt?.trim()) return NextResponse.json({ error: "Prompt is required" }, { status: 400 });

  const cfg = IMAGE_MODELS.find((m) => m.id === model);
  if (!cfg) return NextResponse.json({ error: `Unknown model: ${model}` }, { status: 400 });

  const currentUserId = await resolveUserId(req).catch(() => null);
  if (!currentUserId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let r2ImageUrls: string[] = [];

  if (MANAGED_MODE) {
    r2ImageUrls = imageUrls;
  } else {
    try {
      r2ImageUrls = await resolveImages(imageUrls, currentUserId);
    } catch {
      // image mirroring failures are non-fatal — proceed without reference images
    }
  }

  if (MANAGED_MODE && !azureBaseUrl && model === "gpt-image-2") {
    const session = readSession(req);
    if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const customError = aspectRatio === "custom"
      ? validateAzureCustomSize(azureCustomWidth ?? 0, azureCustomHeight ?? 0)
      : null;
    if (customError) return NextResponse.json({ error: customError }, { status: 400 });
    const sub2apiQuality = quality === "low" || quality === "medium" || quality === "high" || quality === "auto"
      ? quality
      : quality === "4k" ? "high" : "medium";
    const sub2apiResolution = quality === "1k" || quality === "2k" || quality === "4k"
      ? quality
      : azureResolution;
    const taskId = `sub2api-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    jobStore.set(taskId, { status: "pending", type: "image", userId: currentUserId });
    guestDb.insertGeneration({
      task_id: taskId,
      user_id: currentUserId,
      generation_type: "image",
      status: "pending",
      prompt,
      model,
      aspect_ratio: aspectRatio,
      quality: sub2apiQuality,
      reference_image_urls: imageUrls,
    });
    void (async () => {
      try {
        const image = await generateSub2ApiImage({
          apiBaseUrl: session.apiBaseUrl,
          apiKey: session.apiKey,
          userId: currentUserId,
          prompt: prompt.slice(0, cfg.apiInput.promptMaxLength),
          aspectRatio,
          quality: sub2apiQuality,
          resolution: sub2apiResolution,
          customWidth: azureCustomWidth,
          customHeight: azureCustomHeight,
          imageUrls,
        });
        const imageUrl = await uploadBuffer(image.buffer, image.mimeType, "generated", currentUserId);
        jobStore.set(taskId, { status: "done", imageUrl, userId: currentUserId });
        guestDb.updateGeneration(taskId, currentUserId, { status: "done", image_url: imageUrl });
      } catch (error: unknown) {
        const typed = error as { status?: unknown; code?: unknown; message?: unknown };
        const status = typeof typed.status === "number" ? typed.status : 502;
        const code = typeof typed.code === "string" ? typed.code : "upstream_error";
        const message = typeof typed.message === "string" ? typed.message.slice(0, 240) : "Sub2API image request failed";
        const safeMessage = `${status} ${code}: ${message.replace(/[\\r\\n]/g, " ")}`;
        jobStore.set(taskId, { status: "error", error: safeMessage, userId: currentUserId });
        guestDb.updateGeneration(taskId, currentUserId, { status: "error", error_msg: safeMessage });
      }
    })();
    return NextResponse.json({ taskId });
  }
  // ── Azure Foundry branch ──────────────────────────────────────────────────────
  if (azureBaseUrl && azureDeployment) {
    const azureKey = currentUserId
      ? await getAzureKeyForUser(currentUserId)
      : process.env.AZURE_API_KEY ?? null;
    if (!azureKey) return NextResponse.json({ error: "Azure API key is not configured. Add it in Settings." }, { status: 500 });

    const resSizeMaps     = cfg.azureResolutionSizeMaps ?? {};
    const sizeMap         = (azureResolution && resSizeMaps[azureResolution]) ? resSizeMaps[azureResolution] : (cfg.azureSizeMap ?? {});
    const customSizeError = aspectRatio === "custom" && azureCustomWidth && azureCustomHeight
      ? validateAzureCustomSize(azureCustomWidth, azureCustomHeight)
      : null;
    const size            = aspectRatio === "custom" && azureCustomWidth && azureCustomHeight && !customSizeError
      ? `${azureCustomWidth}x${azureCustomHeight}`
      : (sizeMap[aspectRatio] ?? "1024x1024");
    const quality         = azureQuality || "medium";
    const base            = azureBaseUrl.replace(/\/$/, "");
    const azureApiVersion = cfg.azureApiVersion ?? "2025-04-01-preview";
    const truncatedPrompt = prompt.slice(0, cfg.apiInput.promptMaxLength ?? 32000);

    const azureTaskId = `azure-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    jobStore.set(azureTaskId, { status: "pending", type: "image", userId: currentUserId ?? undefined });

    const azureUserId = currentUserId;

    const hasRefImages = r2ImageUrls.length > 0;

    (async () => {
      try {
        let res: { ok: boolean; status: number; text: () => Promise<string> };

        if (hasRefImages) {
          // ── Image-to-image: multipart /images/edits via curl ─────────────
          const azureUrl = `${base}/openai/deployments/${azureDeployment}/images/edits?api-version=${azureApiVersion}`;

          const images = await Promise.all(
            r2ImageUrls.slice(0, cfg.maxImages).map(async (imgUrl) => {
              const buf  = await fetchBuffer(imgUrl, currentUserId);
              const raw  = imgUrl.split("?")[0].split(".").pop()?.toLowerCase() ?? "png";
              const ext  = raw === "jpg" ? "jpeg" : raw;
              const mime = ext === "jpeg" ? "image/jpeg" : "image/png";
              return { buf, ext, mime };
            }),
          );

          const textFields: Record<string, string> = {
            prompt:        truncatedPrompt,
            quality,
            output_format: "png",
            n:             "1",
          };
          if (size && size !== "auto") textFields.size = size;

          const curl = await curlMultipartPost(azureUrl, azureKey, images, textFields);
          res = { ok: curl.ok, status: curl.status, text: () => Promise.resolve(curl.body) };
        } else {
          const azureUrl = `${base}/openai/deployments/${azureDeployment}/images/generations?api-version=${azureApiVersion}`;

          const body: Record<string, unknown> = {
            prompt: truncatedPrompt,
            n: 1,
            output_format: "png",
            output_compression: 100,
            quality,
          };
          if (size && size !== "auto") body.size = size;

          console.log("[azure/generations] request →", { url: azureUrl, method: "POST", body });
          res = await httpsPost(
            azureUrl,
            { "Content-Type": "application/json", Authorization: `Bearer ${azureKey}` },
            JSON.stringify(body),
          );
        }

        const txt = await res.text();
        console.log("[azure] raw response body:", txt.slice(0, 1000));
        if (!res.ok) {
          let displayError = `Azure error ${res.status}`;
          try {
            const parsed = JSON.parse(txt);
            const code   = parsed?.error?.code ?? parsed?.error?.type;
            const friendlyErrors: Record<string, string> = {
              EngineOverloaded: "Model is overloaded right now. Please try again.",
            };
            displayError = code ? (friendlyErrors[code] ?? code) : displayError;
          } catch { /* not JSON */ }
          jobStore.set(azureTaskId, { status: "error", error: displayError, userId: azureUserId ?? undefined });
          return;
        }

        const azureJson = JSON.parse(txt);
        const b64 = azureJson?.data?.[0]?.b64_json as string | undefined;
        if (!b64) {
          jobStore.set(azureTaskId, { status: "error", error: "Azure returned no image data", userId: azureUserId ?? undefined });
          return;
        }

        const buf = Buffer.from(b64, "base64");
        const imageUrl = await uploadBuffer(buf, "image/png", "generated", azureUserId ?? undefined);
        jobStore.set(azureTaskId, { status: "done", imageUrl, userId: azureUserId ?? undefined });

        if (GUEST_MODE || MANAGED_MODE) {
          guestDb.insertGeneration({
            task_id: azureTaskId, user_id: azureUserId, generation_type: "image",
            status: "done", image_url: imageUrl, prompt: prompt.slice(0, 2000),
            model, aspect_ratio: aspectRatio, quality,
            azure_resolution: azureResolution,
            reference_image_urls: hasRefImages ? r2ImageUrls : undefined,
          });
        } else {
          supabaseAdmin.from("generations").insert({
            task_id:              azureTaskId,
            user_id:              azureUserId,
            generation_type:      "image",
            status:               "done",
            image_url:            imageUrl,
            prompt:               prompt.slice(0, 2000),
            model,
            aspect_ratio:         aspectRatio,
            quality,
            azure_resolution:     azureResolution,
            reference_image_urls: hasRefImages ? r2ImageUrls : undefined,
          }).then(({ error }) => {
            if (error) console.error("[azure] supabase insert error:", error.message);
          });
        }
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error("[azure] background error:", msg, e);
        jobStore.set(azureTaskId, { status: "error", error: msg, userId: azureUserId ?? undefined });
      }
    })();

    return NextResponse.json({ taskId: azureTaskId });
  }

  // ── Codex CLI branch ───────────────────────────────────────────────────────────
  // codex-imagegen has no per-user token — it's a single shared `codex login`
  // session on this host — so there's no key lookup here, unlike the other branches.
  if (codexProvider) {
    const codexTaskId = `codex-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    jobStore.set(codexTaskId, { status: "pending", type: "image", userId: currentUserId });

    const codexUserId = currentUserId;
    const size = CODEX_SIZE_MAP[aspectRatio] ?? "auto";

    // "<<<image N>>>" tags are an in-text convention other providers resolve to a
    // URL; codex-imagegen takes images as separate file args, so just flatten the
    // tag to plain prose instead.
    // Codex's --size only offers 4 fixed canvases (no true 4:3/3:4), so spelling out
    // the intended ratio in the prompt steers composition even when the canvas itself
    // is an approximation.
    const codexPrompt = (prompt
      .slice(0, cfg.apiInput.promptMaxLength ?? 8000)
      .replace(/<<<image (\d+)>>>/gi, (_m, n) => `image ${n}`)
      + (aspectRatio && aspectRatio !== "auto" ? ` Aspect ratio: ${aspectRatio}.` : "")).trim();

    (async () => {
      try {
        const images = await Promise.all(
          r2ImageUrls.slice(0, 5).map(async (url) => {
            const buf = await fetchBuffer(url, currentUserId);
            const raw = url.split("?")[0].split(".").pop()?.toLowerCase() ?? "png";
            const ext = raw === "jpg" ? "jpeg" : raw;
            return { buf, ext };
          }),
        );

        const outBuf   = await runCodexImagegen({ prompt: codexPrompt, images, size });
        const imageUrl = await uploadBuffer(outBuf, "image/png", "generated");
        jobStore.set(codexTaskId, { status: "done", imageUrl, userId: codexUserId });

        if (GUEST_MODE) {
          guestDb.insertGeneration({
            task_id: codexTaskId, user_id: codexUserId, generation_type: "image",
            status: "done", image_url: imageUrl, prompt: prompt.slice(0, 2000),
            model, aspect_ratio: aspectRatio, quality,
          });
        } else {
          supabaseAdmin.from("generations").insert({
            task_id:         codexTaskId,
            user_id:         codexUserId,
            generation_type: "image",
            status:          "done",
            image_url:       imageUrl,
            prompt:          prompt.slice(0, 2000),
            model,
            aspect_ratio:    aspectRatio,
            quality,
          }).then(({ error }) => {
            if (error) console.error("[codex] supabase insert error:", error.message);
          });
        }
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error("[codex] background error:", msg, e);
        jobStore.set(codexTaskId, { status: "error", error: cleanCodexError(msg), userId: codexUserId });
      }
    })();

    return NextResponse.json({ taskId: codexTaskId });
  }

  // ── Kie.ai branch ─────────────────────────────────────────────────────────────
  const kieToken = currentUserId ? await getKieTokenForUser(currentUserId) : null;
  if (!kieToken) return NextResponse.json({ error: "No Kie.ai API key configured. Add one in Settings." }, { status: 401 });

  const callbackBase = process.env.CALLBACK_BASE_URL;
  // Guest/desktop mode polls kie.ai directly (see lib/kieJobPoller) so it needs
  // no public callback URL; hosted mode still requires one.
  if (!callbackBase && !GUEST_MODE && !MANAGED_MODE) {
    return NextResponse.json({ error: "CALLBACK_BASE_URL is not set" }, { status: 500 });
  }

  const callBackUrl = MANAGED_MODE
    ? createKieCallbackUrl(HELIOS_PUBLIC_ORIGIN)
    : callbackBase ? `${callbackBase.replace(/\/$/, "")}/api/callback` : undefined;

  try {
    const { apiInput } = cfg;

    const hasImages = MANAGED_MODE ? imageUrls.length > 0 : r2ImageUrls.length > 0;
    const resolvedApiId = !hasImages && cfg.textOnlyApiId ? cfg.textOnlyApiId : cfg.apiId;

    // Kie must receive externally reachable references. Managed media is
    // owner-checked first, then its storage URL is sent only server-side.
    let kieImageUrls = r2ImageUrls;
    if ((GUEST_MODE || MANAGED_MODE) && hasImages) {
      kieImageUrls = await ensureKieReachableImages(kieImageUrls, kieToken, currentUserId);
    }

    const input: Record<string, unknown> = {
      prompt:                    prompt.slice(0, apiInput.promptMaxLength),
      [apiInput.aspectRatioKey]: aspectRatio,
    };

    if (apiInput.outputFormat)               input.output_format           = apiInput.outputFormat;
    if (apiInput.imageInputKey && hasImages) input[apiInput.imageInputKey] = kieImageUrls.slice(0, cfg.maxImages);
    if (apiInput.qualityKey) {
      input[apiInput.qualityKey] = apiInput.qualityMap
        ? (apiInput.qualityMap[quality] ?? quality)
        : quality === "4k" ? "4K" : quality === "2k" ? "2K" : quality === "1k" ? "1K" : quality;
    }
    if (apiInput.extra) Object.assign(input, apiInput.extra);

    const requestBody = { model: resolvedApiId, callBackUrl, input };

    const res = await fetch(CREATE, {
      method:  "POST",
      headers: { Authorization: `Bearer ${kieToken}`, "Content-Type": "application/json" },
      body:    JSON.stringify(requestBody),
    });

    if (!res.ok) {
      if (res.status === 401) throw new Error("Invalid Kie.ai API key — please update it in Settings.");
      throw new Error(await res.text());
    }
    const d = await res.json();
    if (d.code !== undefined && d.code !== 200) throw new Error(d.msg ?? `API error ${d.code}`);

    const taskId = d.data?.taskId ?? d.data?.id ?? d.taskId ?? d.id;
    if (!taskId) throw new Error("No task ID in response");

    jobStore.set(taskId, { status: "pending", type: "image", userId: currentUserId });

    if (GUEST_MODE || MANAGED_MODE) {
      guestDb.insertGeneration({
        task_id: taskId, user_id: currentUserId, generation_type: "image",
        status: "pending", prompt, model, aspect_ratio: aspectRatio, quality,
        reference_image_urls: imageUrls,
      });
      if (GUEST_MODE) pollKieJob(taskId, kieToken, "image");
    } else {
      supabaseAdmin.from("generations").insert({
        task_id: taskId,
        user_id: currentUserId,
        generation_type: "image",
        status: "pending",
        prompt,
        model,
        aspect_ratio: aspectRatio,
        quality,
        reference_image_urls: r2ImageUrls,
      }).then(({ error }) => {
        if (error) console.error("[generate] supabase insert error:", error.message);
      });
    }

    return NextResponse.json({ taskId, referenceImageUrls: r2ImageUrls });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
