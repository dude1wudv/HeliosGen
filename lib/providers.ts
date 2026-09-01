import { IMAGE_MODELS } from "@/lib/modelConfig";

export type ProviderId = "kie" | "azure" | "codex" | "sub2api";

const MANAGED = process.env.SUB2API_MANAGED_MODE === "true" || process.env.NEXT_PUBLIC_SUB2API_MANAGED_MODE === "true";
const ALL_PROVIDERS = [
  { id: "kie", label: "Kie.ai" },
  { id: "azure", label: "Azure Foundry" },
  { id: "codex", label: "Codex CLI" },
  { id: "sub2api", label: "Sub2API (managed)" },
] as const satisfies readonly { id: ProviderId; label: string }[];

export const PROVIDERS = ALL_PROVIDERS.filter((provider) => !MANAGED || (provider.id !== "codex" && provider.id !== "kie" && provider.id !== "azure"));

const STORAGE_KEY = "aiui-model-providers";

export function loadModelProviders(): Record<string, ProviderId> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) as Record<string, ProviderId> : {};
    return MANAGED
      ? Object.fromEntries(Object.entries(parsed).filter(([, provider]) => provider !== "codex"))
      : parsed;
  } catch {
    return {};
  }
}

export function saveModelProviders(map: Record<string, ProviderId>) {
  try {
    const safeMap = MANAGED
      ? Object.fromEntries(Object.entries(map).filter(([, provider]) => provider !== "codex"))
      : map;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(safeMap));
    window.dispatchEvent(new CustomEvent("aiui-providers-changed"));
  } catch { /* browser storage can be unavailable */ }
}

export function getModelProvider(modelId: string): ProviderId {
  const selected = loadModelProviders()[modelId];
  if (MANAGED) return selected === "sub2api" ? selected : "sub2api";
  return selected ?? "kie";
}

export function setModelProvider(modelId: string, provider: ProviderId) {
  if (MANAGED && provider === "codex") return;
  saveModelProviders({ ...loadModelProviders(), [modelId]: provider });
}

const MULTI_PROVIDER_MODEL_IDS = new Set(
  IMAGE_MODELS.filter((model) => !!model.azureSizeMap).map((model) => model.id),
);

export function modelHasProviderChoice(modelId: string): boolean {
  return MULTI_PROVIDER_MODEL_IDS.has(modelId);
}

export function isManagedProvider(provider: ProviderId): provider is "sub2api" {
  return provider === "sub2api";
}
