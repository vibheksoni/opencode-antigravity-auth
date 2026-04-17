import { accessTokenExpired, isOAuthAuth } from "./auth";
import { getCloudCodeEndpointOrder, type CloudCodeRouteState } from "./cloud-code";
import type { ModelModalities } from "./config/models";
import { createLogger } from "./logger";
import { ensureProjectContext } from "./project";
import { refreshAccessToken } from "./token";
import type { AuthDetails, OAuthAuthDetails, Provider, ProviderModel } from "./types";
import { getAntigravityHeaders } from "../constants";

const log = createLogger("model-catalog");

const MODEL_CACHE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_GEMINI_CONTEXT = 1048576;
const DEFAULT_GEMINI_OUTPUT = 65536;
const DEFAULT_CLAUDE_CONTEXT = 200000;
const DEFAULT_CLAUDE_OUTPUT = 64000;

interface CatalogEntryQuotaInfo {
  remainingFraction?: number;
  resetTime?: string;
}

export interface CatalogModelEntry {
  displayName?: string;
  description?: string;
  supportsImages?: boolean;
  supportsThinking?: boolean;
  thinkingBudget?: number;
  minThinkingBudget?: number;
  recommended?: boolean;
  maxTokens?: number;
  maxOutputTokens?: number;
  supportedMimeTypes?: Record<string, boolean>;
  beta?: boolean;
  disabled?: boolean;
  quotaInfo?: CatalogEntryQuotaInfo;
  tagTitle?: string;
  tagDescription?: string;
}

export interface FetchAvailableModelsCatalogResponse {
  models?: Record<string, CatalogModelEntry>;
  defaultAgentModelId?: string;
  commandModelIds?: string[];
  webSearchModelIds?: string[];
  deprecatedModelIds?: Record<string, { newModelId?: string }>;
}

type CachedModelSet = {
  expiresAt: number;
  models: Record<string, ProviderModel>;
};

const discoveredModelCache = new Map<string, CachedModelSet>();

function cloneProviderModels(models: Record<string, ProviderModel>): Record<string, ProviderModel> {
  return Object.fromEntries(
    Object.entries(models).map(([id, model]) => [
      id,
      {
        ...model,
        cost: ((existingCost: any) => ({
          input: existingCost?.input ?? 0,
          output: existingCost?.output ?? 0,
          cache: {
            read: existingCost?.cache?.read ?? 0,
            write: existingCost?.cache?.write ?? 0,
          },
          experimentalOver200K: existingCost?.experimentalOver200K,
        }))(model.cost as any),
      },
    ]),
  );
}

function isClaudeModel(modelId: string): boolean {
  return modelId.toLowerCase().includes("claude");
}

function normalizeLimit(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return Math.max(1, Math.floor(value));
}

function normalizeModalities(entry: CatalogModelEntry, modelId: string): ModelModalities {
  const input = new Set<"text" | "image" | "pdf">(["text"]);
  const output = new Set<"text" | "image" | "pdf">(["text"]);
  const mimeTypes = entry.supportedMimeTypes ?? {};

  if (entry.supportsImages || Object.keys(mimeTypes).some((key) => key.startsWith("image/"))) {
    input.add("image");
  }

  if (mimeTypes["application/pdf"]) {
    input.add("pdf");
  }

  if (modelId.toLowerCase().includes("image")) {
    output.clear();
    output.add("image");
  }

  return {
    input: [...input],
    output: [...output],
  };
}

function normalizeDiscoveredModelId(modelId: string): string {
  return modelId.startsWith("antigravity-") ? modelId : `antigravity-${modelId}`;
}

function inferFamily(modelId: string): string {
  if (isClaudeModel(modelId)) {
    return "claude";
  }
  if (modelId.toLowerCase().includes("flash")) {
    return "gemini-flash";
  }
  return "gemini-pro";
}

function buildCapabilities(entry: CatalogModelEntry, modalities: ModelModalities) {
  return {
    temperature: true,
    reasoning: entry.supportsThinking ?? false,
    attachment: modalities.input.some((item) => item !== "text"),
    toolcall: true,
    input: {
      text: modalities.input.includes("text"),
      audio: false,
      image: modalities.input.includes("image"),
      video: false,
      pdf: modalities.input.includes("pdf"),
    },
    output: {
      text: modalities.output.includes("text"),
      audio: false,
      image: modalities.output.includes("image"),
      video: false,
      pdf: modalities.output.includes("pdf"),
    },
    interleaved: false,
  };
}

function pickTemplateModel(provider: Provider, discoveredId: string): ProviderModel | undefined {
  const exact = provider.models?.[discoveredId];
  if (exact) {
    return exact;
  }

  const baseFamily = isClaudeModel(discoveredId) ? "claude" : "gemini";
  const entries = Object.entries(provider.models ?? {});
  const preferred = entries.find(([id]) => id.includes(baseFamily) && id.startsWith("antigravity-"));
  if (preferred) {
    return preferred[1];
  }
  return entries[0]?.[1];
}

function buildProviderModel(
  provider: Provider,
  discoveredId: string,
  rawModelId: string,
  entry: CatalogModelEntry,
): ProviderModel {
  const template = pickTemplateModel(provider, discoveredId) as any;
  const fallbackContext = isClaudeModel(rawModelId) ? DEFAULT_CLAUDE_CONTEXT : DEFAULT_GEMINI_CONTEXT;
  const fallbackOutput = isClaudeModel(rawModelId) ? DEFAULT_CLAUDE_OUTPUT : DEFAULT_GEMINI_OUTPUT;
  const modalities = normalizeModalities(entry, rawModelId);

  return {
    ...template,
    name: entry.displayName ? `${entry.displayName} (Antigravity)` : `${rawModelId} (Antigravity)`,
    family: inferFamily(rawModelId),
    api: {
      id: rawModelId,
      url: template?.api?.url ?? "",
      npm: template?.api?.npm ?? "@ai-sdk/google",
    },
    capabilities: buildCapabilities(entry, modalities),
    status: entry.beta ? "beta" : template?.status ?? "active",
    headers: template?.headers ?? {},
    options: template?.options ?? {},
    release_date: template?.release_date ?? "",
    variants: template?.variants,
    limit: {
      context: normalizeLimit(entry.maxTokens, template?.limit?.context ?? fallbackContext),
      input: template?.limit?.input,
      output: normalizeLimit(entry.maxOutputTokens, template?.limit?.output ?? fallbackOutput),
    },
    cost: {
      input: template?.cost?.input ?? 0,
      output: template?.cost?.output ?? 0,
      cache: {
        read: template?.cost?.cache?.read ?? 0,
        write: template?.cost?.cache?.write ?? 0,
      },
      experimentalOver200K: template?.cost?.experimentalOver200K,
    } as any,
  };
}

export function buildDiscoveredModels(
  catalog: FetchAvailableModelsCatalogResponse,
  provider: Provider,
): Record<string, ProviderModel> {
  const result: Record<string, ProviderModel> = {};
  const deprecatedIds = new Set(Object.keys(catalog.deprecatedModelIds ?? {}));

  for (const [rawModelId, entry] of Object.entries(catalog.models ?? {})) {
    if (!entry || entry.disabled || deprecatedIds.has(rawModelId)) {
      continue;
    }

    const providerModelId = normalizeDiscoveredModelId(rawModelId);
    result[providerModelId] = buildProviderModel(provider, providerModelId, rawModelId, entry);
  }

  return result;
}

export async function fetchAvailableModelsCatalog(
  accessToken: string,
  projectId: string,
  routeState?: CloudCodeRouteState,
): Promise<FetchAvailableModelsCatalogResponse> {
  const errors: string[] = [];

  for (const endpoint of getCloudCodeEndpointOrder(routeState)) {
    try {
      const response = await fetch(`${endpoint}/v1internal:fetchAvailableModels`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
          "User-Agent": getAntigravityHeaders()["User-Agent"],
        },
        body: JSON.stringify(projectId ? { project: projectId } : {}),
      });

      if (response.ok) {
        return (await response.json()) as FetchAvailableModelsCatalogResponse;
      }

      const bodyText = await response.text().catch(() => "");
      const snippet = bodyText.trim().slice(0, 200);
      errors.push(`fetchAvailableModels ${response.status} at ${endpoint}${snippet ? `: ${snippet}` : ""}`);
    } catch (error) {
      errors.push(`fetchAvailableModels error at ${endpoint}: ${String(error)}`);
    }
  }

  throw new Error(errors.join("; ") || "fetchAvailableModels failed");
}

function getModelCacheKey(auth: OAuthAuthDetails, projectId: string): string {
  return `${auth.refresh}::${projectId}`;
}

export async function getRuntimeAntigravityModels(
  auth: AuthDetails | undefined,
  provider: Provider,
): Promise<Record<string, ProviderModel>> {
  const fallback = cloneProviderModels(provider.models ?? {});

  if (!auth || !isOAuthAuth(auth)) {
    return fallback;
  }

  try {
    let readyAuth = auth;
    if (accessTokenExpired(readyAuth)) {
      readyAuth = (await refreshAccessToken(readyAuth)) ?? readyAuth;
    }

    if (!readyAuth.access) {
      return fallback;
    }

    const projectContext = await ensureProjectContext(readyAuth);
    if (!projectContext.auth.access) {
      return fallback;
    }
    const cacheKey = getModelCacheKey(projectContext.auth, projectContext.effectiveProjectId);
    const now = Date.now();
    const cached = discoveredModelCache.get(cacheKey);

    if (cached && cached.expiresAt > now) {
      return {
        ...fallback,
        ...cloneProviderModels(cached.models),
      };
    }

    const catalog = await fetchAvailableModelsCatalog(
      projectContext.auth.access,
      projectContext.effectiveProjectId,
      projectContext.routeState,
    );

    const discovered = buildDiscoveredModels(catalog, provider);
    if (Object.keys(discovered).length === 0) {
      return fallback;
    }

    discoveredModelCache.set(cacheKey, {
      expiresAt: now + MODEL_CACHE_TTL_MS,
      models: discovered,
    });

    return {
      ...fallback,
      ...cloneProviderModels(discovered),
    };
  } catch (error) {
    log.debug("Failed to discover runtime Antigravity models", { error: String(error) });
    return fallback;
  }
}
