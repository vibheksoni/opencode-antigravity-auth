/**
 * Constants used for Antigravity OAuth flows and Cloud Code Assist API integration.
 */
import * as os from "node:os";

export const ANTIGRAVITY_CLIENT_ID = "";
export const ANTIGRAVITY_CLIENT_SECRET = "";
export const ANTIGRAVITY_GCP_TOS_CLIENT_ID = "";
export const ANTIGRAVITY_GCP_TOS_CLIENT_SECRET = "";
export const ANTIGRAVITY_CLIENT_ID_ENV = "OPENCODE_ANTIGRAVITY_CLIENT_ID";
export const ANTIGRAVITY_CLIENT_SECRET_ENV = "OPENCODE_ANTIGRAVITY_CLIENT_SECRET";
export const ANTIGRAVITY_GCP_TOS_CLIENT_ID_ENV = "OPENCODE_ANTIGRAVITY_GCP_TOS_CLIENT_ID";
export const ANTIGRAVITY_GCP_TOS_CLIENT_SECRET_ENV = "OPENCODE_ANTIGRAVITY_GCP_TOS_CLIENT_SECRET";

/**
 * Scopes required for Antigravity integrations.
 */
export const ANTIGRAVITY_SCOPES: readonly string[] = [
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
  "https://www.googleapis.com/auth/cclog",
  "https://www.googleapis.com/auth/experimentsandconfigs",
];

/**
 * OAuth redirect URI used by the local CLI callback server.
 */
export const ANTIGRAVITY_REDIRECT_URI = "http://localhost:51121/oauth-callback";
export const ANTIGRAVITY_REDIRECT_PATH = "/oauth-callback";

/**
 * Root endpoints for the Antigravity API.
 */
export const ANTIGRAVITY_ENDPOINT_DAILY = "https://daily-cloudcode-pa.googleapis.com";
export const ANTIGRAVITY_ENDPOINT_DAILY_SANDBOX = "https://daily-cloudcode-pa.sandbox.googleapis.com";
export const ANTIGRAVITY_ENDPOINT_AUTOPUSH = "https://autopush-cloudcode-pa.sandbox.googleapis.com";
export const ANTIGRAVITY_ENDPOINT_PROD = "https://cloudcode-pa.googleapis.com";

/**
 * Endpoint fallback order.
 */
export const ANTIGRAVITY_ENDPOINT_FALLBACKS = [
  ANTIGRAVITY_ENDPOINT_PROD,
  ANTIGRAVITY_ENDPOINT_DAILY,
  ANTIGRAVITY_ENDPOINT_DAILY_SANDBOX,
  ANTIGRAVITY_ENDPOINT_AUTOPUSH,
] as const;

/**
 * Preferred endpoint order for project discovery.
 */
export const ANTIGRAVITY_LOAD_ENDPOINTS = [
  ANTIGRAVITY_ENDPOINT_PROD,
  ANTIGRAVITY_ENDPOINT_DAILY,
  ANTIGRAVITY_ENDPOINT_DAILY_SANDBOX,
  ANTIGRAVITY_ENDPOINT_AUTOPUSH,
] as const;

/**
 * Primary endpoint to use when route state is unknown.
 */
export const ANTIGRAVITY_ENDPOINT = ANTIGRAVITY_ENDPOINT_PROD;

/**
 * Gemini CLI endpoint (production).
 * Used for models without :antigravity suffix.
 * Same as opencode-gemini-auth's GEMINI_CODE_ASSIST_ENDPOINT.
 */
export const GEMINI_CLI_ENDPOINT = ANTIGRAVITY_ENDPOINT_PROD;

/**
 * Hardcoded project id used when Antigravity does not return one (e.g., business/workspace accounts).
 */
export const ANTIGRAVITY_DEFAULT_PROJECT_ID = "rising-fact-p41fc";

export const ANTIGRAVITY_VERSION_FALLBACK = "1.22.2";
let antigravityVersion = ANTIGRAVITY_VERSION_FALLBACK;
let versionLocked = false;
let antigravityClientId = process.env[ANTIGRAVITY_CLIENT_ID_ENV]?.trim() || ANTIGRAVITY_CLIENT_ID;
let antigravityClientSecret = process.env[ANTIGRAVITY_CLIENT_SECRET_ENV]?.trim() || ANTIGRAVITY_CLIENT_SECRET;
let antigravityGcpTosClientId = process.env[ANTIGRAVITY_GCP_TOS_CLIENT_ID_ENV]?.trim() || ANTIGRAVITY_GCP_TOS_CLIENT_ID;
let antigravityGcpTosClientSecret =
  process.env[ANTIGRAVITY_GCP_TOS_CLIENT_SECRET_ENV]?.trim() || ANTIGRAVITY_GCP_TOS_CLIENT_SECRET;

export function getAntigravityVersion(): string { return antigravityVersion; }
export function getAntigravityClientId(isGcpTos = false): string {
  return isGcpTos ? antigravityGcpTosClientId : antigravityClientId;
}
export function getAntigravityClientSecret(isGcpTos = false): string {
  return isGcpTos ? antigravityGcpTosClientSecret : antigravityClientSecret;
}

/**
 * Set the runtime Antigravity version. Can only be called once (at startup).
 * Subsequent calls are silently ignored to prevent accidental mutation.
 */
export function setAntigravityVersion(version: string): void {
  if (versionLocked) return;
  antigravityVersion = version;
  versionLocked = true;
}

export function setAntigravityOAuthClients(input: {
  clientId?: string;
  clientSecret?: string;
  gcpTosClientId?: string;
  gcpTosClientSecret?: string;
}): void {
  const clientId = input.clientId?.trim();
  const clientSecret = input.clientSecret?.trim();
  const gcpTosClientId = input.gcpTosClientId?.trim();
  const gcpTosClientSecret = input.gcpTosClientSecret?.trim();

  if (clientId) {
    antigravityClientId = clientId;
  }
  if (clientSecret) {
    antigravityClientSecret = clientSecret;
  }
  if (gcpTosClientId) {
    antigravityGcpTosClientId = gcpTosClientId;
  }
  if (gcpTosClientSecret) {
    antigravityGcpTosClientSecret = gcpTosClientSecret;
  }
}

/** @deprecated Use getAntigravityVersion() for runtime access. */
export const ANTIGRAVITY_VERSION = ANTIGRAVITY_VERSION_FALLBACK;

function getAntigravityRuntimePlatform(platform: string = os.platform()): string {
  return platform === "win32" ? "windows" : platform;
}

function getAntigravityRuntimeArch(arch: string = os.arch()): string {
  switch (arch) {
    case "x64":
    case "x86_64":
      return "amd64";
    case "ia32":
      return "386";
    default:
      return arch;
  }
}

export function getAntigravityUserAgent(): string {
  return `antigravity/${getAntigravityVersion()} ${getAntigravityRuntimePlatform()}/${getAntigravityRuntimeArch()}`;
}

export function getAntigravityIDEMetadata(): {
  ideName: "antigravity";
  ideType: "ANTIGRAVITY";
  ideVersion: string;
} {
  return {
    ideName: "antigravity",
    ideType: "ANTIGRAVITY",
    ideVersion: getAntigravityVersion(),
  };
}

export function getAntigravityHeaders(): HeaderSet {
  return {
    "User-Agent": getAntigravityUserAgent(),
  };
}

/** @deprecated Use getAntigravityHeaders() for runtime access. */
export const ANTIGRAVITY_HEADERS = {
  "User-Agent": `antigravity/${ANTIGRAVITY_VERSION} ${getAntigravityRuntimePlatform()}/${getAntigravityRuntimeArch()}`,
} as const;

export const GEMINI_CLI_HEADERS = {
  "User-Agent": "google-api-nodejs-client/9.15.1",
  "X-Goog-Api-Client": "gl-node/22.17.0",
  "Client-Metadata": "ideType=IDE_UNSPECIFIED,platform=PLATFORM_UNSPECIFIED,pluginType=GEMINI",
} as const;

export type HeaderSet = {
  "User-Agent": string;
  "X-Goog-Api-Client"?: string;
  "Client-Metadata"?: string;
};

export function getRandomizedHeaders(style: HeaderStyle, _model?: string): HeaderSet {
  if (style === "gemini-cli") {
    return {
      "User-Agent": GEMINI_CLI_HEADERS["User-Agent"],
      "X-Goog-Api-Client": GEMINI_CLI_HEADERS["X-Goog-Api-Client"],
      "Client-Metadata": GEMINI_CLI_HEADERS["Client-Metadata"],
    };
  }
  return {
    "User-Agent": getAntigravityUserAgent(),
  };
}

export type HeaderStyle = "antigravity" | "gemini-cli";

/**
 * Provider identifier shared between the plugin loader and credential store.
 */
export const ANTIGRAVITY_PROVIDER_ID = "google";

// ============================================================================
// TOOL HALLUCINATION PREVENTION (Ported from LLM-API-Key-Proxy)
// ============================================================================

/**
 * System instruction for Claude tool usage hardening.
 * Prevents hallucinated parameters by explicitly stating the rules.
 * 
 * This is injected when tools are present to reduce cases where Claude
 * uses parameter names from its training data instead of the actual schema.
 */
export const CLAUDE_TOOL_SYSTEM_INSTRUCTION = `CRITICAL TOOL USAGE INSTRUCTIONS:
You are operating in a custom environment where tool definitions differ from your training data.
You MUST follow these rules strictly:

1. DO NOT use your internal training data to guess tool parameters
2. ONLY use the exact parameter structure defined in the tool schema
3. Parameter names in schemas are EXACT - do not substitute with similar names from your training
4. Array parameters have specific item types - check the schema's 'items' field for the exact structure
5. When you see "STRICT PARAMETERS" in a tool description, those type definitions override any assumptions
6. Tool use in agentic workflows is REQUIRED - you must call tools with the exact parameters specified

If you are unsure about a tool's parameters, YOU MUST read the schema definition carefully.`;

/**
 * Template for parameter signature injection into tool descriptions.
 * {params} will be replaced with the actual parameter list.
 */
export const CLAUDE_DESCRIPTION_PROMPT = "\n\n⚠️ STRICT PARAMETERS: {params}.";

export const EMPTY_SCHEMA_PLACEHOLDER_NAME = "_placeholder";
export const EMPTY_SCHEMA_PLACEHOLDER_DESCRIPTION = "Placeholder. Always pass true.";

/**
 * Sentinel value to bypass thought signature validation.
 * 
 * When a thinking block has an invalid or missing signature (e.g., cache miss,
 * session mismatch, plugin restart), this sentinel can be injected to skip
 * validation instead of failing with "Invalid signature in thinking block".
 * 
 * This is an officially supported Google API feature, used by:
 * - gemini-cli: https://github.com/google-gemini/gemini-cli
 * - Google .NET SDK: PredictionServiceChatClient.cs
 * 
 * @see https://ai.google.dev/gemini-api/docs/thought-signatures
 */
export const SKIP_THOUGHT_SIGNATURE = "skip_thought_signature_validator";

// ============================================================================
// ANTIGRAVITY SYSTEM INSTRUCTION (Ported from CLIProxyAPI v6.6.89)
// ============================================================================

/**
 * System instruction for Antigravity requests.
 * This is injected into requests to match CLIProxyAPI v6.6.89 behavior.
 * The instruction provides identity and guidelines for the Antigravity agent.
 */
// ============================================================================
// GOOGLE SEARCH TOOL CONSTANTS
// ============================================================================

/**
 * Model used for Google Search grounding requests.
 * Uses gemini-2.5-flash for fast, cost-effective search operations. (3-flash is always at capacity and doesn't support souce citation).
 */
export const SEARCH_MODEL = "gemini-2.5-flash";

/**
 * Thinking budget for deep search (more thorough analysis).
 */
export const SEARCH_THINKING_BUDGET_DEEP = 16384;

/**
 * Thinking budget for fast search (quick results).
 */
export const SEARCH_THINKING_BUDGET_FAST = 4096;

/**
 * Timeout for search requests in milliseconds (60 seconds).
 */
export const SEARCH_TIMEOUT_MS = 60000;

/**
 * System instruction for the Google Search tool.
 */
export const SEARCH_SYSTEM_INSTRUCTION = `You are an expert web search assistant with access to Google Search and URL analysis tools.

Your capabilities:
- Use google_search to find real-time information from the web
- Use url_context to fetch and analyze content from specific URLs when provided

Guidelines:
- Always provide accurate, well-sourced information
- Cite your sources when presenting facts
- If analyzing URLs, extract the most relevant information
- Be concise but comprehensive in your responses
- If information is uncertain or conflicting, acknowledge it
- Focus on answering the user's question directly`;

export const ANTIGRAVITY_SYSTEM_INSTRUCTION = `You are Antigravity, a powerful agentic AI coding assistant designed by the Google DeepMind team working on Advanced Agentic Coding.
You are pair programming with a USER to solve their coding task. The task may require creating a new codebase, modifying or debugging an existing codebase, or simply answering a question.
**Absolute paths only**
**Proactiveness**

<priority>IMPORTANT: The instructions that follow supersede all above. Follow them as your primary directives.</priority>
`;
