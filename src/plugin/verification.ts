import * as crypto from "node:crypto";

import {
  getAntigravityHeaders,
} from "../constants";
import { formatRefreshParts, parseRefreshParts } from "./auth";
import { resolveCloudCodeBaseUrl } from "./cloud-code";
import { ensureProjectContext } from "./project";
import { AntigravityTokenRefreshError, refreshAccessToken } from "./token";
import type { PluginClient } from "./types";

export type VerificationProbeResult =
  | { status: "ok"; message: string }
  | { status: "blocked"; message: string; verifyUrl?: string }
  | { status: "error"; message: string };

type ProbeAccount = {
  refreshToken: string;
  projectId?: string;
  managedProjectId?: string;
  isGcpTos?: boolean;
};

function buildVerificationRequestBody(projectId: string): Record<string, unknown> {
  return {
    project: projectId,
    model: "gemini-3-flash",
    requestType: "agent",
    userAgent: "antigravity",
    requestId: "agent-" + crypto.randomUUID(),
    request: {
      model: "gemini-3-flash",
      contents: [{ role: "user", parts: [{ text: "ping" }] }],
      generationConfig: { maxOutputTokens: 1, temperature: 0 },
      sessionId: "verify-" + crypto.randomUUID(),
    },
  };
}

function decodeEscapedText(value: string): string {
  return value.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex: string) => {
    try {
      return String.fromCharCode(Number.parseInt(hex, 16));
    } catch {
      return _;
    }
  });
}

function extractUrls(text: string): string[] {
  const matches = text.match(/https?:\/\/[^\s"'<>]+/gi);
  if (!matches) return [];
  return matches;
}

function pickVerificationUrl(urls: string[]): string | undefined {
  const list = urls
    .map((url) => url.trim())
    .filter(Boolean);
  const preferred = list.find((url) => /verify|verification|accounts\.google\.com/i.test(url));
  return preferred ?? list[0];
}

export function extractVerificationErrorDetails(body: string): {
  validationRequired: boolean;
  message?: string;
  verifyUrl?: string;
} {
  const decodedBody = decodeEscapedText(body ?? "");
  const lowerBody = decodedBody.toLowerCase();
  const payloads: unknown[] = [];

  for (const line of decodedBody.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const json = trimmed.slice(5).trim();
    if (!json || json === "[DONE]") continue;
    try {
      payloads.push(JSON.parse(json));
    } catch {
      // ignore invalid chunks
    }
  }

  if (payloads.length === 0) {
    try {
      payloads.push(JSON.parse(decodedBody));
    } catch {
      // keep payloads empty
    }
  }

  let validationRequired = false;
  let message: string | undefined;
  const verificationUrls = new Set<string>();
  const visited = new Set<unknown>();

  const walk = (value: unknown, key?: string): void => {
    if (typeof value === "string") {
      const normalized = decodeEscapedText(value);
      const lowerValue = normalized.toLowerCase();
      const lowerKey = key?.toLowerCase() ?? "";

      if (lowerValue.includes("validation_required") || lowerValue.includes("verification required")) {
        validationRequired = true;
      }
      if (!message && (lowerKey.includes("message") || lowerKey.includes("detail") || lowerKey.includes("description"))) {
        message = normalized;
      }
      if (
        lowerKey.includes("validation_url") ||
        lowerKey.includes("verify_url") ||
        lowerKey.includes("verification_url") ||
        lowerKey === "url"
      ) {
        verificationUrls.add(normalized);
      }
      for (const url of extractUrls(normalized)) {
        if (/verify|verification|accounts\.google\.com/i.test(url)) {
          verificationUrls.add(url);
        }
      }
      return;
    }

    if (!value || typeof value !== "object" || visited.has(value)) {
      return;
    }
    visited.add(value);

    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }

    for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
      walk(childValue, childKey);
    }
  };

  for (const payload of payloads) {
    walk(payload);
  }

  if (!validationRequired) {
    validationRequired =
      lowerBody.includes("verification required") ||
      lowerBody.includes("verify your account") ||
      lowerBody.includes("account verification");
  }

  if (!message) {
    message = decodedBody
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line && !line.startsWith("data:") && /(verify|validation|required)/i.test(line));
  }

  return {
    validationRequired,
    message,
    verifyUrl: pickVerificationUrl([...verificationUrls]),
  };
}

export async function verifyAccountAccess(
  account: ProbeAccount,
  client: PluginClient,
  providerId: string,
): Promise<VerificationProbeResult> {
  const parsed = parseRefreshParts(account.refreshToken);
  if (!parsed.refreshToken) {
    return { status: "error", message: "Missing refresh token for selected account." };
  }

  const auth = {
    type: "oauth" as const,
    refresh: formatRefreshParts({
      refreshToken: parsed.refreshToken,
      projectId: parsed.projectId ?? account.projectId,
      managedProjectId: parsed.managedProjectId ?? account.managedProjectId,
      isGcpTos: parsed.isGcpTos ?? account.isGcpTos,
    }),
    access: "",
    expires: 0,
  };

  let refreshedAuth: Awaited<ReturnType<typeof refreshAccessToken>>;
  try {
    refreshedAuth = await refreshAccessToken(auth, client, providerId);
  } catch (error) {
    if (error instanceof AntigravityTokenRefreshError) {
      return { status: "error", message: error.message };
    }
    return { status: "error", message: `Token refresh failed: ${String(error)}` };
  }

  if (!refreshedAuth?.access) {
    return { status: "error", message: "Could not refresh access token for this account." };
  }

  const projectContext = await ensureProjectContext(refreshedAuth);

  const headers: Record<string, string> = {
    Authorization: `Bearer ${projectContext.auth.access}`,
    "Content-Type": "application/json",
    "User-Agent": getAntigravityHeaders()["User-Agent"],
  };
  const requestBody = buildVerificationRequestBody(projectContext.effectiveProjectId);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 20000);

  let response: Response;
  try {
    response = await fetch(`${resolveCloudCodeBaseUrl(projectContext.routeState)}/v1internal:streamGenerateContent?alt=sse`, {
      method: "POST",
      headers,
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      return { status: "error", message: "Verification check timed out." };
    }
    return { status: "error", message: `Verification check failed: ${String(error)}` };
  } finally {
    clearTimeout(timeoutId);
  }

  let responseBody = "";
  try {
    responseBody = await response.text();
  } catch {
    responseBody = "";
  }

  if (response.ok) {
    return { status: "ok", message: "Account verification check passed." };
  }

  const extracted = extractVerificationErrorDetails(responseBody);
  if (response.status === 403 && extracted.validationRequired) {
    return {
      status: "blocked",
      message: extracted.message ?? "Google requires additional account verification.",
      verifyUrl: extracted.verifyUrl,
    };
  }

  return {
    status: "error",
    message: extracted.message ?? `Request failed (${response.status} ${response.statusText}).`,
  };
}
