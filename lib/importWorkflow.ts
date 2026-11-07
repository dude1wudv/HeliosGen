import { appFetch, appPath, logicalAppPath } from "@/lib/appPaths";
/**
 * Import a workflow ("space") from a `.zip` produced by `lib/exportWorkflow.ts`:
 *
 *   workflow.json      — nodes, edges, counters, viewport (asset URLs point at
 *                        the bundled files)
 *   assets/<hash>.<ext> — every referenced image/video
 *
 * Each bundled asset is re-uploaded to local storage via `/api/upload-asset`
 * and its `assets/…` reference in the workflow is rewritten to the fresh URL.
 * Failed uploads are counted; callers must reject copies with skipped assets.
 */
import type { Edge, Node } from "@xyflow/react";
import type { NodeData } from "./store";
import { WORKFLOW_FORMAT } from "./exportWorkflow";
import { crc32 } from "./makeZip";

const ASSET_PREFIX = "assets/";
const MAX_ARCHIVE_BYTES = 200 * 1024 * 1024;
const MAX_ENTRY_BYTES = 100 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 300 * 1024 * 1024;
const MAX_ENTRIES = 2000;

// ── Minimal ZIP reader ────────────────────────────────────────────────────────
// Handles STORE (0) entries directly and DEFLATE (8) via DecompressionStream,
// scanning local file headers sequentially. Enough for our own exports and for
// zips produced by standard tools.

interface UnzipEntry {
  name: string;
  data: Uint8Array;
}

async function inflateRaw(data: Uint8Array, limit: number): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(
    new DecompressionStream("deflate-raw"),
  );
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) throw new Error("ZIP 解压内容过大，请保留原文件并拆分后导入。");
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
  return result;
}

async function unzip(buf: ArrayBuffer): Promise<UnzipEntry[]> {
  const view = new DataView(buf);
  const bytes = new Uint8Array(buf);
  if (bytes.length < 22) throw new Error("ZIP 文件不完整，请重新导出。");
  const decoder = new TextDecoder();
  const entries: UnzipEntry[] = [];
  // A complete backup includes its central directory and end record. Checking
  // only local entries accepts archives truncated cleanly between two files.
  let end = -1;
  for (let pos = bytes.length - 22; pos >= Math.max(0, bytes.length - 22 - 0xffff); pos--) {
    if (view.getUint32(pos, true) === 0x06054b50 && pos + 22 + view.getUint16(pos + 20, true) === bytes.length) {
      end = pos;
      break;
    }
  }
  if (end < 0) throw new Error("ZIP 文件不完整，请重新导出。");
  const count = view.getUint16(end + 10, true);
  const centralSize = view.getUint32(end + 12, true);
  const centralOffset = view.getUint32(end + 16, true);
  if (view.getUint16(end + 4, true) !== 0 || view.getUint16(end + 6, true) !== 0 ||
      view.getUint16(end + 8, true) !== count || count > MAX_ENTRIES ||
      centralOffset + centralSize !== end) throw new Error("ZIP 目录无效或不支持分卷归档。");
  const directory = new Map<number, { name: string; flags: number; compression: number; checksum: number; compSize: number; originalSize: number }>();
  let centralPos = centralOffset;
  for (let index = 0; index < count; index++) {
    if (centralPos + 46 > end || view.getUint32(centralPos, true) !== 0x02014b50) throw new Error("ZIP 文件目录不完整，请重新导出。");
    const nameLen = view.getUint16(centralPos + 28, true);
    const next = centralPos + 46 + nameLen + view.getUint16(centralPos + 30, true) + view.getUint16(centralPos + 32, true);
    const localOffset = view.getUint32(centralPos + 42, true);
    if (next > end || localOffset >= centralOffset || directory.has(localOffset) || view.getUint16(centralPos + 34, true) !== 0) throw new Error("ZIP 文件目录无效。");
    directory.set(localOffset, {
      name: decoder.decode(bytes.subarray(centralPos + 46, centralPos + 46 + nameLen)),
      flags: view.getUint16(centralPos + 8, true), compression: view.getUint16(centralPos + 10, true),
      checksum: view.getUint32(centralPos + 16, true), compSize: view.getUint32(centralPos + 20, true),
      originalSize: view.getUint32(centralPos + 24, true),
    });
    centralPos = next;
  }
  if (centralPos !== end) throw new Error("ZIP 文件目录无效。");
  let off = 0;
  let expandedBytes = 0;
  const names = new Set<string>();

  while (off + 30 <= centralOffset && view.getUint32(off, true) === 0x04034b50) {
    const flags = view.getUint16(off + 6, true);
    const compression = view.getUint16(off + 8, true);
    const checksum = view.getUint32(off + 14, true);
    const compSize = view.getUint32(off + 18, true);
    const originalSize = view.getUint32(off + 22, true);
    const nameLen = view.getUint16(off + 26, true);
    const extraLen = view.getUint16(off + 28, true);
    const nameStart = off + 30;
    const name = decoder.decode(bytes.subarray(nameStart, nameStart + nameLen));
    const dataStart = nameStart + nameLen + extraLen;
    if (dataStart > centralOffset || compSize > centralOffset - dataStart) throw new Error("ZIP 文件不完整，请重新导出。");
    const indexed = directory.get(off);
    if (!indexed || indexed.name !== name || indexed.flags !== flags || indexed.compression !== compression ||
        indexed.checksum !== checksum || indexed.compSize !== compSize || indexed.originalSize !== originalSize) {
      throw new Error("ZIP 文件校验失败：目录与内容不一致，请重新导出。");
    }
    if (flags & 1) throw new Error("不支持加密的工作流 ZIP。");
    if (!name || names.has(name) || name.startsWith("/") || name.includes("\\") || name.split("/").some(part => part === "..")) throw new Error("ZIP 文件路径无效或重复。");
    if (names.size >= MAX_ENTRIES || originalSize > MAX_ENTRY_BYTES || expandedBytes + originalSize > MAX_EXPANDED_BYTES) throw new Error("ZIP 解压内容过大，请拆分后导入。");
    names.add(name);

    if (flags & 0x08) {
      throw new Error("zip uses streaming data descriptors — re-export the workflow");
    }

    const raw = bytes.slice(dataStart, dataStart + compSize);
    let data: Uint8Array;
    if (compression === 0) data = raw;
    else if (compression === 8) data = await inflateRaw(raw, Math.min(MAX_ENTRY_BYTES, MAX_EXPANDED_BYTES - expandedBytes, originalSize));
    else throw new Error(`unsupported zip compression method ${compression}`);

    if (data.length !== originalSize || crc32(data) !== checksum) throw new Error("ZIP 文件校验失败，请重新导出。");
    expandedBytes += data.length;
    entries.push({ name, data });
    off = dataStart + compSize;
  }

  if (off !== centralOffset || entries.length !== count) throw new Error("ZIP 文件目录与内容不完整，请重新导出。");
  return entries;
}

// ── Asset content types ───────────────────────────────────────────────────────

function contentTypeFromName(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  switch (ext) {
    case "mp4": return "video/mp4";
    case "webm": return "video/webm";
    case "png": return "image/png";
    case "gif": return "image/gif";
    case "webp": return "image/webp";
    case "jpg":
    case "jpeg": return "image/jpeg";
    default: return "application/octet-stream";
  }
}

// ── Rewrite bundled asset paths back to real URLs ─────────────────────────────

type Json = unknown;

function rewrite(value: Json, pathToUrl: Map<string, string>): Json {
  if (Array.isArray(value)) return value.map((v) => rewrite(v, pathToUrl));
  if (value && typeof value === "object") {
    const out: Record<string, Json> = {};
    for (const [k, v] of Object.entries(value)) out[k] = rewrite(v, pathToUrl);
    return out;
  }
  if (typeof value === "string" && value.startsWith(ASSET_PREFIX) && pathToUrl.has(value)) {
    return pathToUrl.get(value)!;
  }
  if (typeof value === "string" && logicalAppPath(value).startsWith("/api/media/")) return appPath(logicalAppPath(value));
  return value;
}

// ── Public API ────────────────────────────────────────────────────────────────

export interface ImportedWorkflow {
  name: string;
  nodes: Node<NodeData>[];
  edges: Edge[];
  nodeCounters: Record<string, number>;
  viewport?: { x: number; y: number; zoom: number };
  assetCount: number;
  skipped: number;
}

export async function importWorkflowZip(file: File): Promise<ImportedWorkflow> {
  if (file.size > MAX_ARCHIVE_BYTES) throw new Error("ZIP 文件过大（最多 200 MB），请拆分后导入。");
  const entries = await unzip(await file.arrayBuffer());

  const manifestEntry = entries.find((e) => e.name === "workflow.json");
  if (!manifestEntry) throw new Error("workflow.json not found in zip");

  let manifest: {
    format?: string;
    version?: number;
    name?: string;
    workflow?: {
      name?: string;
      nodes?: Node<NodeData>[];
      edges?: Edge[];
      nodeCounters?: Record<string, number>;
      viewport?: { x: number; y: number; zoom: number };
    };
  };
  try {
    manifest = JSON.parse(new TextDecoder().decode(manifestEntry.data));
  } catch {
    throw new Error("workflow.json is not valid JSON");
  }

  if (!manifest || manifest.format !== WORKFLOW_FORMAT || (manifest.version !== undefined && manifest.version !== 1)) {
    throw new Error("this zip is not a HeliosGen workflow export");
  }

  const wf = manifest.workflow ?? {};
  const rawNodes = Array.isArray(wf.nodes) ? wf.nodes : [];
  if (rawNodes.length === 0) throw new Error("workflow has no nodes");
  const edges = wf.edges ?? [];
  if (rawNodes.length > 10000 || !Array.isArray(edges) || edges.length > 20000 ||
      !rawNodes.every(node => node && typeof node.id === "string" && node.data && typeof node.data === "object" &&
        node.position && Number.isFinite(node.position.x) && Number.isFinite(node.position.y)) ||
      !edges.every(edge => edge && typeof edge.id === "string" && typeof edge.source === "string" && typeof edge.target === "string")) {
    throw new Error("工作流数据不完整，未导入任何内容。");
  }
  // Validate every bundled reference before uploading anything. A missing ZIP
  // entry must never produce a seemingly successful but broken workflow copy.
  const references = new Set<string>();
  const collect = (value: unknown, depth = 0): void => {
    if (depth > 100) throw new Error("工作流数据嵌套过深。");
    if (typeof value === "string" && value.startsWith(ASSET_PREFIX)) references.add(value);
    else if (Array.isArray(value)) value.forEach(item => collect(item, depth + 1));
    else if (value && typeof value === "object") Object.values(value).forEach(item => collect(item, depth + 1));
  };
  collect(rawNodes);
  for (const reference of references) {
    if (!entries.some(entry => entry.name === reference)) throw new Error("ZIP 缺少工作流引用的媒体，未导入任何内容。请保留原文件后重新导出。");
  }

  // Re-upload every bundled asset, mapping its path → fresh URL.
  const pathToUrl = new Map<string, string>();
  let skipped = 0;
  for (const entry of entries) {
    if (!entry.name.startsWith(ASSET_PREFIX)) continue;
    try {
      const res = await appFetch("/api/upload-asset", {
        method: "POST",
        headers: { "Content-Type": contentTypeFromName(entry.name) },
        body: entry.data as BodyInit,
      });
      if (!res.ok) throw new Error(`upload ${entry.name} → ${res.status}`);
      const { cdnUrl } = (await res.json()) as { cdnUrl: string };
      if (typeof cdnUrl !== "string" || !cdnUrl) throw new Error("Media upload returned no URL");
      pathToUrl.set(entry.name, cdnUrl);
    } catch {
      skipped++;
    }
  }

  const nodes = rawNodes.map((n) => ({
    ...n,
    data: rewrite(n.data, pathToUrl) as NodeData,
  }));

  return {
    name: typeof wf.name === "string" && wf.name ? wf.name : typeof manifest.name === "string" && manifest.name ? manifest.name : "Imported workflow",
    nodes,
    edges,
    nodeCounters: wf.nodeCounters ?? {},
    viewport: wf.viewport,
    assetCount: pathToUrl.size,
    skipped,
  };
}
