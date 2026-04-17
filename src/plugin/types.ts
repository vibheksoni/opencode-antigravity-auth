import type { PluginInput } from "@opencode-ai/plugin";
import type { AntigravityTokenExchangeResult } from "../antigravity/oauth";
import type { CloudCodeRouteState } from "./cloud-code";

export interface OAuthAuthDetails {
  type: "oauth";
  refresh: string;
  access?: string;
  expires?: number;
}

export interface ApiKeyAuthDetails {
  type: "api_key";
  key: string;
}

export interface NonOAuthAuthDetails {
  type: string;
  [key: string]: unknown;
}

export type AuthDetails = OAuthAuthDetails | ApiKeyAuthDetails | NonOAuthAuthDetails;

export type GetAuth = () => Promise<AuthDetails>;

export interface ProviderModelCapabilities {
  temperature?: boolean;
  reasoning?: boolean;
  attachment?: boolean;
  toolcall?: boolean;
  input?: Partial<Record<"text" | "audio" | "image" | "video" | "pdf", boolean>>;
  output?: Partial<Record<"text" | "audio" | "image" | "video" | "pdf", boolean>>;
  interleaved?: boolean | { field: "reasoning_content" | "reasoning_details" };
}

export interface ProviderModelCost {
  input: number;
  output: number;
  cache?: {
    read: number;
    write: number;
  };
  experimentalOver200K?: {
    input: number;
    output: number;
    cache?: {
      read: number;
      write: number;
    };
  };
}

export interface ProviderModelLimit {
  context: number;
  input?: number;
  output: number;
}

export interface ProviderModel {
  id?: string;
  providerID?: string;
  name?: string;
  family?: string;
  api?: {
    id?: string;
    url?: string;
    npm?: string;
  };
  capabilities?: ProviderModelCapabilities;
  cost?: ProviderModelCost;
  limit?: ProviderModelLimit;
  status?: "alpha" | "beta" | "deprecated" | "active" | string;
  headers?: Record<string, string>;
  options?: Record<string, unknown>;
  release_date?: string;
  variants?: Record<string, Record<string, unknown>>;
  [key: string]: unknown;
}

export interface Provider {
  models?: Record<string, ProviderModel>;
}

export interface ProviderHookContext {
  auth?: AuthDetails;
}

export interface ProviderHook {
  id: string;
  models?: (
    provider: Provider,
    ctx: ProviderHookContext,
  ) => Promise<Record<string, ProviderModel>>;
}

export interface LoaderResult {
  apiKey: string;
  fetch(input: RequestInfo, init?: RequestInit): Promise<Response>;
}

export type PluginClient = PluginInput["client"];

export interface PluginContext {
  client: PluginClient;
  directory: string;
}

export type AuthPrompt =
  | {
      type: "text";
      key: string;
      message: string;
      placeholder?: string;
      validate?: (value: string) => string | undefined;
      condition?: (inputs: Record<string, string>) => boolean;
    }
  | {
      type: "select";
      key: string;
      message: string;
      options: Array<{ label: string; value: string; hint?: string }>;
      condition?: (inputs: Record<string, string>) => boolean;
    };

export type OAuthAuthorizationResult = { url: string; instructions: string } & (
  | {
      method: "auto";
      callback: () => Promise<AntigravityTokenExchangeResult>;
    }
  | {
      method: "code";
      callback: (code: string) => Promise<AntigravityTokenExchangeResult>;
    }
);

export interface AuthMethod {
  provider?: string;
  label: string;
  type: "oauth" | "api";
  prompts?: AuthPrompt[];
  authorize?: (inputs?: Record<string, string>) => Promise<OAuthAuthorizationResult>;
}

export interface PluginEventPayload {
  event: {
    type: string;
    properties?: unknown;
  };
}

export interface PluginResult {
  auth: {
    provider: string;
    loader: (getAuth: GetAuth, provider: Provider) => Promise<LoaderResult | Record<string, unknown>>;
    methods: AuthMethod[];
  };
  provider?: ProviderHook;
  event?: (payload: PluginEventPayload) => void;
  tool?: Record<string, unknown>;
}

export interface RefreshParts {
  refreshToken: string;
  projectId?: string;
  managedProjectId?: string;
  isGcpTos?: boolean;
}

export interface ProjectContextResult {
  auth: OAuthAuthDetails;
  effectiveProjectId: string;
  routeState?: CloudCodeRouteState;
}

