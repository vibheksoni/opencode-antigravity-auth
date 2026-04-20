import {
  ANTIGRAVITY_REDIRECT_URI,
  ANTIGRAVITY_SCOPES,
  getAntigravityClientId,
  getAntigravityClientSecret,
  getAntigravityHeaders,
  getAntigravityIDEMetadata,
  GEMINI_CLI_HEADERS,
} from "../constants";
import { getCloudCodeEndpointOrder } from "../plugin/cloud-code";
import { createGoogleOAuth2Client } from "../plugin/google-auth";
import { createLogger } from "../plugin/logger";
import { calculateTokenExpiry, formatRefreshParts } from "../plugin/auth";

const log = createLogger("oauth");

interface OAuthClientOptions {
  redirectUri: string;
  isGcpTos?: boolean;
}

interface AntigravityAuthState {
  projectId: string;
}

/**
 * Result returned to the caller after constructing an OAuth authorization URL.
 */
export interface AntigravityAuthorization {
  url: string;
  redirectUri: string;
  projectId: string;
  isGcpTos?: boolean;
}

interface AntigravityTokenExchangeSuccess {
  type: "success";
  refresh: string;
  access: string;
  expires: number;
  email?: string;
  projectId: string;
  isGcpTos?: boolean;
}

interface AntigravityTokenExchangeFailure {
  type: "failed";
  error: string;
}

export type AntigravityTokenExchangeResult =
  | AntigravityTokenExchangeSuccess
  | AntigravityTokenExchangeFailure;

interface AntigravityTokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token: string;
  id_token?: string;
}

interface AntigravityUserInfo {
  email?: string;
}

function normalizeEmail(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const email = value.trim().toLowerCase();
  if (!email) return undefined;
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return undefined;
  return email;
}

function decodeBase64Url(value: string): string {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), "=");
  return Buffer.from(padded, "base64").toString("utf8");
}

function extractEmailFromIdToken(idToken?: string): string | undefined {
  if (!idToken) return undefined;
  const parts = idToken.split(".");
  if (parts.length < 2 || !parts[1]) return undefined;
  try {
    const payload = JSON.parse(decodeBase64Url(parts[1])) as Record<string, unknown>;
    return normalizeEmail(payload.email);
  } catch {
    return undefined;
  }
}

/**
 * Encode an object into a URL-safe base64 string.
 */
function encodeState(payload: AntigravityAuthState): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

/**
 * Decode an OAuth state parameter back into its structured representation.
 */
function decodeState(state: string): AntigravityAuthState {
  const normalized = state.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(normalized.length + ((4 - normalized.length % 4) % 4), "=");
  const json = Buffer.from(padded, "base64").toString("utf8");
  const parsed = JSON.parse(json);
  return {
    projectId: typeof parsed.projectId === "string" ? parsed.projectId : "",
  };
}

async function createOAuthClient(options: OAuthClientOptions) {
  const clientId = getAntigravityClientId(options.isGcpTos);
  const clientSecret = getAntigravityClientSecret(options.isGcpTos);
  if (!clientId || !clientSecret) {
    throw new Error(
      "Antigravity OAuth client metadata is unavailable. Install the local Antigravity app or set OPENCODE_ANTIGRAVITY_CLIENT_ID / OPENCODE_ANTIGRAVITY_CLIENT_SECRET (and the GCP ToS equivalents if needed).",
    );
  }
  return createGoogleOAuth2Client(clientId, clientSecret, options.redirectUri);
}

/**
 * Build the Antigravity OAuth authorization URL including PKCE and optional project metadata.
 */
export async function authorizeAntigravity(
  projectId = "",
  options: { redirectUri?: string; isGcpTos?: boolean } = {},
): Promise<AntigravityAuthorization> {
  const redirectUri = options.redirectUri?.trim() || ANTIGRAVITY_REDIRECT_URI;
  const client = await createOAuthClient({
    redirectUri,
    isGcpTos: options.isGcpTos,
  });
  const url = client.generateAuthUrl({
    access_type: "offline",
    scope: [...ANTIGRAVITY_SCOPES],
    state: encodeState({ projectId: projectId || "" }),
    prompt: "consent",
  });

  return {
    url,
    redirectUri,
    projectId: projectId || "",
    isGcpTos: options.isGcpTos,
  };
}

const FETCH_TIMEOUT_MS = 10000;

async function fetchWithTimeout(
  url: string,
  options: RequestInit,
  timeoutMs = FETCH_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchProjectID(accessToken: string): Promise<string> {
  const errors: string[] = [];
  const loadHeaders: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
    "User-Agent": getAntigravityHeaders()["User-Agent"],
  };

  for (const baseEndpoint of getCloudCodeEndpointOrder()) {
    try {
      const url = `${baseEndpoint}/v1internal:loadCodeAssist`;
      const response = await fetchWithTimeout(url, {
        method: "POST",
        headers: loadHeaders,
        body: JSON.stringify({
          metadata: getAntigravityIDEMetadata(),
        }),
      });

      if (!response.ok) {
        const message = await response.text().catch(() => "");
        errors.push(
          `loadCodeAssist ${response.status} at ${baseEndpoint}${
            message ? `: ${message}` : ""
          }`,
        );
        continue;
      }

      let data = await response.json();
      if (!data.paidTier && data.cloudaicompanionProject) {
        const secondResponse = await fetchWithTimeout(url, {
          method: "POST",
          headers: loadHeaders,
          body: JSON.stringify({
            metadata: getAntigravityIDEMetadata(),
          }),
        });

        if (secondResponse.ok) {
          data = await secondResponse.json();
        }
      }

      if (typeof data.cloudaicompanionProject === "string" && data.cloudaicompanionProject) {
        return data.cloudaicompanionProject;
      }
      if (
        data.cloudaicompanionProject &&
        typeof data.cloudaicompanionProject.id === "string" &&
        data.cloudaicompanionProject.id
      ) {
        return data.cloudaicompanionProject.id;
      }

      errors.push(`loadCodeAssist missing project id at ${baseEndpoint}`);
    } catch (e) {
      errors.push(
        `loadCodeAssist error at ${baseEndpoint}: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
  }

  if (errors.length) {
    log.warn("Failed to resolve Antigravity project via loadCodeAssist", { errors: errors.join("; ") });
  }
  return "";
}

/**
 * Exchange an authorization code for Antigravity CLI access and refresh tokens.
 */
export async function exchangeAntigravity(
  code: string,
  state: string,
  options: { redirectUri?: string; isGcpTos?: boolean } = {},
): Promise<AntigravityTokenExchangeResult> {
  try {
    const { projectId } = decodeState(state);
    const redirectUri = options.redirectUri?.trim() || ANTIGRAVITY_REDIRECT_URI;
    const client = await createOAuthClient({
      redirectUri,
      isGcpTos: options.isGcpTos,
    });

    const startTime = Date.now();
    const { tokens } = await client.getToken({
      code,
      redirect_uri: redirectUri,
    });
    const tokenPayload = tokens as AntigravityTokenResponse & { expiry_date?: number };

    let resolvedEmail = extractEmailFromIdToken(tokenPayload.id_token);

    if (!resolvedEmail) {
      const userInfoResponse = await fetch(
        "https://www.googleapis.com/oauth2/v1/userinfo?alt=json",
        {
          headers: {
            Authorization: `Bearer ${tokenPayload.access_token}`,
            "User-Agent": GEMINI_CLI_HEADERS["User-Agent"],
          },
        },
      );

      if (userInfoResponse.ok) {
        const userInfo = (await userInfoResponse.json()) as AntigravityUserInfo;
        resolvedEmail = normalizeEmail(userInfo.email);
      }
    }

    const refreshToken = tokenPayload.refresh_token;
    if (!refreshToken) {
      return { type: "failed", error: "Missing refresh token in response" };
    }

    let effectiveProjectId = projectId;
    if (!effectiveProjectId) {
      effectiveProjectId = await fetchProjectID(tokenPayload.access_token);
    }

    const packedRefresh = formatRefreshParts({
      refreshToken,
      projectId: effectiveProjectId || "",
      isGcpTos: options.isGcpTos,
    });

    return {
      type: "success",
      refresh: packedRefresh,
      access: tokenPayload.access_token,
      expires:
        typeof tokenPayload.expiry_date === "number"
          ? tokenPayload.expiry_date
          : calculateTokenExpiry(startTime, tokenPayload.expires_in),
      email: resolvedEmail,
      projectId: effectiveProjectId || "",
      isGcpTos: options.isGcpTos,
    };
  } catch (error) {
    return {
      type: "failed",
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}
