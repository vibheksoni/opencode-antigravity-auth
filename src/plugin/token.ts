import { spawnSync } from "node:child_process";
import {
  getAntigravityClientId,
  getAntigravityClientSecret,
} from "../constants";
import { fileURLToPath } from "node:url";
import { formatRefreshParts, parseRefreshParts, calculateTokenExpiry } from "./auth";
import { clearCachedAuth, storeCachedAuth } from "./cache";
import { createGoogleOAuth2Client } from "./google-auth";
import { createLogger } from "./logger";
import { invalidateProjectContextCache } from "./project";
import { findLocalAntigravityAppRoot } from "./runtime-metadata";
import type { OAuthAuthDetails, PluginClient, RefreshParts } from "./types";

const log = createLogger("token");

interface OAuthErrorPayload {
  error?:
    | string
    | {
        code?: string;
        status?: string;
        message?: string;
      };
  error_description?: string;
}

/**
 * Parses OAuth error payloads returned by Google token endpoints, tolerating varied shapes.
 */
function parseOAuthErrorPayload(text: string | undefined): { code?: string; description?: string } {
  if (!text) {
    return {};
  }

  try {
    const payload = JSON.parse(text) as OAuthErrorPayload;
    if (!payload || typeof payload !== "object") {
      return { description: text };
    }

    let code: string | undefined;
    if (typeof payload.error === "string") {
      code = payload.error;
    } else if (payload.error && typeof payload.error === "object") {
      code = payload.error.status ?? payload.error.code;
      if (!payload.error_description && payload.error.message) {
        return { code, description: payload.error.message };
      }
    }

    const description = payload.error_description;
    if (description) {
      return { code, description };
    }

    if (payload.error && typeof payload.error === "object" && payload.error.message) {
      return { code, description: payload.error.message };
    }

    return { code };
  } catch {
    return { description: text };
  }
}

export class AntigravityTokenRefreshError extends Error {
  code?: string;
  description?: string;
  status: number;
  statusText: string;

  constructor(options: {
    message: string;
    code?: string;
    description?: string;
    status: number;
    statusText: string;
  }) {
    super(options.message);
    this.name = "AntigravityTokenRefreshError";
    this.code = options.code;
    this.description = options.description;
    this.status = options.status;
    this.statusText = options.statusText;
  }
}

/**
 * Refreshes an Antigravity OAuth access token, updates persisted credentials, and handles revocation.
 */
export async function refreshAccessToken(
  auth: OAuthAuthDetails,
  client?: PluginClient,
  providerId?: string,
): Promise<OAuthAuthDetails | undefined> {
  const parts = parseRefreshParts(auth.refresh);
  if (!parts.refreshToken) {
    return undefined;
  }

  log.debug("token-refresh-start", {
    providerId,
    hasAccess: !!auth.access,
    expires: auth.expires,
    hasProjectId: !!parts.projectId,
    hasManagedProjectId: !!parts.managedProjectId,
    isGcpTos: !!parts.isGcpTos,
    refreshTokenLength: parts.refreshToken.length,
  });

  try {
    const clientId = getAntigravityClientId(parts.isGcpTos);
    const clientSecret = getAntigravityClientSecret(parts.isGcpTos);
    log.debug("token-refresh-metadata", {
      isGcpTos: !!parts.isGcpTos,
      hasClientId: !!clientId,
      hasClientSecret: !!clientSecret,
      appRoot: findLocalAntigravityAppRoot(),
    });
    const oauth = await createGoogleOAuth2Client(
      clientId,
      clientSecret,
    );
    if (!clientId || !clientSecret) {
      throw new AntigravityTokenRefreshError({
        message:
          "Antigravity OAuth client metadata is unavailable. Install the local Antigravity app or set the OPENCODE_ANTIGRAVITY_* OAuth client environment variables.",
        status: 0,
        statusText: "Missing OAuth client metadata",
      });
    }
    oauth.setCredentials({
      refresh_token: parts.refreshToken,
    });

    let payload: {
      access_token?: string | null;
      expiry_date?: number | null;
      refresh_token?: string | null;
      token_type?: string | null;
      expires_in?: number | null;
    };

    try {
      const refreshed = await oauth.refreshAccessToken();
      payload = refreshed.credentials;
    } catch (error) {
      const response = (error as { response?: { status?: number; statusText?: string; data?: unknown } }).response;
      let errorText: string | undefined;
      if (typeof response?.data === "string") {
        errorText = response.data;
      } else if (response?.data !== undefined) {
        try {
          errorText = JSON.stringify(response.data);
        } catch {
          errorText = String(response.data);
        }
      }

      const { code, description } = parseOAuthErrorPayload(errorText);
      const status = response?.status ?? 0;
      const statusText = response?.statusText ?? "Token refresh failed";
      const details = [code, description ?? errorText].filter(Boolean).join(": ");
      const baseMessage = `Antigravity token refresh failed (${status} ${statusText})`;
      const message = details ? `${baseMessage} - ${details}` : baseMessage;
      log.warn("Token refresh failed", { status, code, details });

      if (code === "invalid_grant") {
        log.warn("Google revoked the stored refresh token - reauthentication required");
        invalidateProjectContextCache(auth.refresh);
        clearCachedAuth(auth.refresh);
      }

      throw new AntigravityTokenRefreshError({
        message,
        code,
        description: description ?? errorText,
        status,
        statusText,
      });
    }

    if (!payload.access_token) {
      log.error("token-refresh-missing-access-token", {
        hasExpiryDate: typeof payload.expiry_date === "number",
        hasExpiresIn: typeof payload.expires_in === "number",
        hasRefreshToken: !!payload.refresh_token,
        tokenType: payload.token_type ?? null,
      });
      throw new AntigravityTokenRefreshError({
        message: "Antigravity token refresh response was missing access_token.",
        status: 0,
        statusText: "Missing access token",
      });
    }

    const refreshedParts: RefreshParts = {
      refreshToken: payload.refresh_token ?? parts.refreshToken,
      projectId: parts.projectId,
      managedProjectId: parts.managedProjectId,
    };

    const updatedAuth: OAuthAuthDetails = {
      ...auth,
      access: payload.access_token,
      expires:
        typeof payload.expiry_date === "number"
          ? payload.expiry_date
          : calculateTokenExpiry(Date.now(), payload.expires_in),
      refresh: formatRefreshParts(refreshedParts),
    };

    storeCachedAuth(updatedAuth);
    invalidateProjectContextCache(auth.refresh);
    log.debug("token-refresh-success", {
      hasAccess: !!updatedAuth.access,
      expires: updatedAuth.expires,
      rotatedRefreshToken: refreshedParts.refreshToken !== parts.refreshToken,
      hasProjectId: !!refreshedParts.projectId,
      hasManagedProjectId: !!refreshedParts.managedProjectId,
    });

    return updatedAuth;
  } catch (error) {
    if (isOAuthClientInteropError(error)) {
      const clientId = getAntigravityClientId(parts.isGcpTos);
      const clientSecret = getAntigravityClientSecret(parts.isGcpTos);
      log.warn("token-refresh-interop-fallback", {
        appRoot: findLocalAntigravityAppRoot(),
      });
      const refreshed = refreshAccessTokenViaSubprocess(auth, clientId, clientSecret);
      storeCachedAuth(refreshed);
      invalidateProjectContextCache(auth.refresh);
      log.debug("token-refresh-success", {
        hasAccess: !!refreshed.access,
        expires: refreshed.expires,
        rotatedRefreshToken: refreshed.refresh !== auth.refresh,
      });
      return refreshed;
    }
    if (error instanceof AntigravityTokenRefreshError) {
      throw error;
    }
    log.error("Unexpected token refresh error", { error: formatRefreshError(error) });
    return undefined;
  }
}

function isOAuthClientInteropError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("google-auth-library did not expose OAuth2Client");
}

function resolveSubprocessModulePath(sourceRelative: string, distRelative: string): string {
  return import.meta.url.includes("/dist/")
    ? fileURLToPath(new URL(distRelative, import.meta.url))
    : fileURLToPath(new URL(sourceRelative, import.meta.url));
}

function refreshAccessTokenViaSubprocess(
  auth: OAuthAuthDetails,
  clientId: string,
  clientSecret: string,
): OAuthAuthDetails {
  const helperPath = resolveSubprocessModulePath("./google-auth.ts", "./google-auth.js");
  const authPath = resolveSubprocessModulePath("./auth.ts", "./auth.js");
  const script = [
    `const payload = JSON.parse(require("node:fs").readFileSync(0, "utf8"));`,
    `const { pathToFileURL } = await import("node:url");`,
    `const { createGoogleOAuth2Client } = await import(pathToFileURL(payload.helperPath).href);`,
    `const { parseRefreshParts, formatRefreshParts, calculateTokenExpiry } = await import(pathToFileURL(payload.authPath).href);`,
    `const parts = parseRefreshParts(payload.auth.refresh);`,
    `const oauth = await createGoogleOAuth2Client(payload.clientId, payload.clientSecret);`,
    `oauth.setCredentials({ refresh_token: parts.refreshToken });`,
    `const startedAt = Date.now();`,
    `const refreshed = await oauth.refreshAccessToken();`,
    `const credentials = refreshed.credentials;`,
    `if (!credentials.access_token) throw new Error("No access token returned from subprocess refresh.");`,
    `const result = {`,
    `  ...payload.auth,`,
    `  access: credentials.access_token,`,
    `  expires: typeof credentials.expiry_date === "number" ? credentials.expiry_date : calculateTokenExpiry(startedAt, credentials.expires_in),`,
    `  refresh: formatRefreshParts({`,
    `    refreshToken: credentials.refresh_token ?? parts.refreshToken,`,
    `    projectId: parts.projectId,`,
    `    managedProjectId: parts.managedProjectId,`,
    `    isGcpTos: parts.isGcpTos,`,
    `  }),`,
    `};`,
    `console.log(JSON.stringify(result));`,
  ].join("\n");

  const command = process.execPath.toLowerCase().includes("node") ? process.execPath : "node";
  const child = spawnSync(command, ["-e", script], {
    input: JSON.stringify({ auth, helperPath, authPath, clientId, clientSecret }),
    encoding: "utf8",
    windowsHide: true,
    env: process.env,
  });

  if (child.status !== 0) {
    throw new Error(child.stderr?.trim() || child.error?.message || "Subprocess token refresh failed.");
  }

  const output = child.stdout?.trim();
  if (!output) {
    throw new Error("Subprocess token refresh returned empty output.");
  }

  return JSON.parse(output) as OAuthAuthDetails;
}

function formatRefreshError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

