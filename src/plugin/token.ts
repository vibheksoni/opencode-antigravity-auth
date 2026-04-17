import { OAuth2Client } from "google-auth-library";

import {
  getAntigravityClientId,
  getAntigravityClientSecret,
} from "../constants";
import { formatRefreshParts, parseRefreshParts, calculateTokenExpiry } from "./auth";
import { clearCachedAuth, storeCachedAuth } from "./cache";
import { createLogger } from "./logger";
import { invalidateProjectContextCache } from "./project";
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

  try {
    const oauth = new OAuth2Client(
      getAntigravityClientId(parts.isGcpTos),
      getAntigravityClientSecret(parts.isGcpTos),
    );
    if (!getAntigravityClientId(parts.isGcpTos) || !getAntigravityClientSecret(parts.isGcpTos)) {
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

    const refreshedParts: RefreshParts = {
      refreshToken: payload.refresh_token ?? parts.refreshToken,
      projectId: parts.projectId,
      managedProjectId: parts.managedProjectId,
    };

    const updatedAuth: OAuthAuthDetails = {
      ...auth,
      access: payload.access_token ?? "",
      expires:
        typeof payload.expiry_date === "number"
          ? payload.expiry_date
          : calculateTokenExpiry(Date.now(), payload.expires_in),
      refresh: formatRefreshParts(refreshedParts),
    };

    storeCachedAuth(updatedAuth);
    invalidateProjectContextCache(auth.refresh);

    return updatedAuth;
  } catch (error) {
    if (error instanceof AntigravityTokenRefreshError) {
      throw error;
    }
    log.error("Unexpected token refresh error", { error: String(error) });
    return undefined;
  }
}

