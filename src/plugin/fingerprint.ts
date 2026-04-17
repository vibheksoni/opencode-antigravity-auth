/**
 * Device Fingerprint Generator for Rate Limit Mitigation
 *
 * Ported from antigravity-claude-proxy PR #170
 * https://github.com/badrisnarayanan/antigravity-claude-proxy/pull/170
 *
 * Generates randomized device fingerprints to help distribute API usage
 * across different apparent device identities.
 */

import * as crypto from "node:crypto";
import * as os from "node:os";
import { getAntigravityUserAgent, getAntigravityVersion } from "../constants";

const IDE_TYPES = [
  "ANTIGRAVITY",
] as const;

export interface ClientMetadata {
  ideType: string;
  platform: string;
  pluginType: string;
}

export interface Fingerprint {
  deviceId: string;
  sessionToken: string;
  userAgent: string;
  apiClient: string;
  clientMetadata: ClientMetadata;
  createdAt: number;
  /** @deprecated Kept for backward compat with stored fingerprints */
  quotaUser?: string;
}

/**
 * Fingerprint version for history tracking.
 * Stores a snapshot of a fingerprint with metadata about when/why it was saved.
 */
export interface FingerprintVersion {
  fingerprint: Fingerprint;
  timestamp: number;
  reason: 'initial' | 'regenerated' | 'restored';
}

/** Maximum number of fingerprint versions to keep per account */
export const MAX_FINGERPRINT_HISTORY = 5;

export interface FingerprintHeaders {
  "User-Agent": string;
}

function generateDeviceId(): string {
  return crypto.randomUUID();
}

function generateSessionToken(): string {
  return crypto.randomBytes(16).toString("hex");
}

/**
 * Generate a randomized device fingerprint.
 * Each fingerprint represents a unique "device" identity.
 */
export function generateFingerprint(): Fingerprint {
  const platform = os.platform();

  const matchingPlatform =
    platform === "win32"
      ? "WINDOWS"
      : "MACOS";

  return {
    deviceId: generateDeviceId(),
    sessionToken: generateSessionToken(),
    userAgent: getAntigravityUserAgent(),
    apiClient: "google-cloud-sdk vscode_cloudshelleditor/0.1",
    clientMetadata: {
      ideType: IDE_TYPES[0],
      platform: matchingPlatform,
      pluginType: "GEMINI",
    },
    createdAt: Date.now(),
  };
}

/**
 * Collect fingerprint based on actual current system.
 * Uses real OS info instead of randomized values.
 */
export function collectCurrentFingerprint(): Fingerprint {
  const platform = os.platform();

  const matchingPlatform =
    platform === "win32"
      ? "WINDOWS"
      : "MACOS";

  return {
    deviceId: generateDeviceId(),
    sessionToken: generateSessionToken(),
    userAgent: getAntigravityUserAgent(),
    apiClient: "google-cloud-sdk vscode_cloudshelleditor/0.1",
    clientMetadata: {
      ideType: "ANTIGRAVITY",
      platform: matchingPlatform,
      pluginType: "GEMINI",
    },
    createdAt: Date.now(),
  };
}

/**
 * Update the version in a fingerprint's userAgent to match the current runtime version.
 * Called after version fetcher resolves so saved fingerprints always carry the latest version.
 * Returns true if the userAgent was changed.
 */
export function updateFingerprintVersion(fingerprint: Fingerprint): boolean {
  const currentVersion = getAntigravityVersion();
  const versionPattern = /^(antigravity\/)([\d.]+)/;
  const match = fingerprint.userAgent.match(versionPattern);

  if (!match || match[2] === currentVersion) {
    return false;
  }

  fingerprint.userAgent = fingerprint.userAgent.replace(versionPattern, `$1${currentVersion}`);
  return true;
}

/**
 * Build HTTP headers from a fingerprint object.
 * These headers are used to identify the "device" making API requests.
 */
export function buildFingerprintHeaders(fingerprint: Fingerprint | null): Partial<FingerprintHeaders> {
  if (!fingerprint) {
    return {};
  }

  return {
    "User-Agent": fingerprint.userAgent,
  };
}

/**
 * Session-level fingerprint instance.
 * Generated once at module load, persists for the lifetime of the process.
 */
let sessionFingerprint: Fingerprint | null = null;

/**
 * Get or create the session fingerprint.
 * Returns the same fingerprint for all calls within a session.
 */
export function getSessionFingerprint(): Fingerprint {
  if (!sessionFingerprint) {
    sessionFingerprint = generateFingerprint();
  }
  return sessionFingerprint;
}

/**
 * Regenerate the session fingerprint.
 * Call this to get a fresh identity (e.g., after rate limiting).
 */
export function regenerateSessionFingerprint(): Fingerprint {
  sessionFingerprint = generateFingerprint();
  return sessionFingerprint;
}
