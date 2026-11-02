import { appPath, logicalAppPath } from "./appPaths";
import type { Space } from "./store";

export interface RecoveryManifest {
  format: "heliosgen-recovery";
  version: 1;
  exportedAt?: string;
  workflows: Space[];
}

function plain(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Only application-owned media references change; user prompts are untouched. */
function restoreMedia(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(restoreMedia);
  if (plain(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, restoreMedia(item)]));
  if (typeof value === "string" && logicalAppPath(value).startsWith("/api/media/")) return appPath(logicalAppPath(value));
  return value;
}

/** Validate the whole file before the caller creates any copies. Never restores IDs or credentials. */
export function parseWorkflowRecovery(text: string): Space[] {
  if (new TextEncoder().encode(text).byteLength > 50 * 1024 * 1024) throw new Error("恢复文件过大（最多 50 MB）。");
  const manifest: unknown = JSON.parse(text);
  if (!plain(manifest) || manifest.format !== "heliosgen-recovery" || manifest.version !== 1 || !Array.isArray(manifest.workflows)) {
    throw new Error("请选择旧画布恢复页导出的工作流文件。");
  }
  if (manifest.workflows.length > 500) throw new Error("单次最多导入 500 个工作流。");
  return manifest.workflows.map((value) => {
    if (!plain(value) || typeof value.name !== "string" || !Array.isArray(value.nodes) || !Array.isArray(value.edges) ||
        value.nodes.length > 10000 || value.edges.length > 20000 ||
        !value.nodes.every((node) => plain(node) && typeof node.id === "string" && plain(node.data) && plain(node.position) && Number.isFinite(node.position.x) && Number.isFinite(node.position.y)) ||
        !value.edges.every((edge) => plain(edge) && typeof edge.id === "string" && typeof edge.source === "string" && typeof edge.target === "string")) {
      throw new Error("工作流数据不完整，未导入任何内容。请保留原文件。");
    }
    const viewport = plain(value.viewport) && [value.viewport.x, value.viewport.y, value.viewport.zoom].every((item) => typeof item === "number" && Number.isFinite(item))
      ? value.viewport as Space["viewport"] : undefined;
    return {
      id: "", // The store creates a fresh ID; the original can never be overwritten.
      name: `${value.name.slice(0, 160) || "未命名工作流"}（恢复副本）`,
      nodes: restoreMedia(value.nodes) as Space["nodes"],
      edges: value.edges as Space["edges"],
      nodeCounters: plain(value.nodeCounters) ? Object.fromEntries(Object.entries(value.nodeCounters).filter(([, count]) => typeof count === "number" && Number.isFinite(count))) as Record<string, number> : {},
      viewport,
      createdAt: Date.now(),
    };
  });
}
