import type { AntigravityTokenExchangeResult } from "../antigravity/oauth";
import { formatRefreshParts, parseRefreshParts } from "./auth";
import { loadAccounts, saveAccounts } from "./storage";

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, Math.floor(value)));
}

/**
 * Normalize an email address for stable account deduplication.
 *
 * @param value unknown - Candidate email value.
 * @returns string | undefined - Lowercased email or undefined when invalid.
 */
export function normalizeEmail(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const email = value.trim().toLowerCase();
  if (!email) return undefined;
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return undefined;
  return email;
}

/**
 * Persist one or more successful OAuth logins into the shared account pool.
 *
 * @param results Array<Extract<AntigravityTokenExchangeResult, { type: "success" }>> - Successful exchanges to save.
 * @param replaceAll boolean - Whether to replace the existing pool instead of merging.
 * @returns Promise<void> - Resolves after storage is updated.
 */
export async function persistAccountPool(
  results: Array<Extract<AntigravityTokenExchangeResult, { type: "success" }>>,
  replaceAll: boolean = false,
): Promise<void> {
  if (results.length === 0) {
    return;
  }

  const now = Date.now();
  const stored = replaceAll ? null : await loadAccounts();
  const accounts = stored?.accounts ? [...stored.accounts] : [];

  const indexByRefreshToken = new Map<string, number>();
  const indexByEmail = new Map<string, number>();
  for (let i = 0; i < accounts.length; i++) {
    const acc = accounts[i];
    if (acc?.refreshToken) {
      indexByRefreshToken.set(acc.refreshToken, i);
    }
    if (acc?.email) {
      indexByEmail.set(acc.email, i);
    }
  }

  for (const result of results) {
    const parts = parseRefreshParts(result.refresh);
    if (!parts.refreshToken) {
      continue;
    }
    const email = normalizeEmail(result.email);
    const existingByEmail = email ? indexByEmail.get(email) : undefined;
    const existingByToken = indexByRefreshToken.get(parts.refreshToken);
    const existingIndex = existingByEmail ?? existingByToken;

    if (existingIndex === undefined) {
      const newIndex = accounts.length;
      indexByRefreshToken.set(parts.refreshToken, newIndex);
      if (email) {
        indexByEmail.set(email, newIndex);
      }
      accounts.push({
        email,
        refreshToken: parts.refreshToken,
        projectId: parts.projectId,
        managedProjectId: parts.managedProjectId,
        isGcpTos: parts.isGcpTos,
        addedAt: now,
        lastUsed: now,
        enabled: true,
      });
      continue;
    }

    const existing = accounts[existingIndex];
    if (!existing) {
      continue;
    }

    const oldToken = existing.refreshToken;
    accounts[existingIndex] = {
      ...existing,
      email: email ?? existing.email,
      refreshToken: parts.refreshToken,
      projectId: parts.projectId ?? existing.projectId,
      managedProjectId: parts.managedProjectId ?? existing.managedProjectId,
      isGcpTos: parts.isGcpTos ?? existing.isGcpTos,
      lastUsed: now,
    };

    if (oldToken !== parts.refreshToken) {
      indexByRefreshToken.delete(oldToken);
      indexByRefreshToken.set(parts.refreshToken, existingIndex);
    }
  }

  if (accounts.length === 0) {
    return;
  }

  const activeIndex = replaceAll
    ? 0
    : (typeof stored?.activeIndex === "number" && Number.isFinite(stored.activeIndex) ? stored.activeIndex : 0);

  await saveAccounts({
    version: 4,
    accounts,
    activeIndex: clampInt(activeIndex, 0, accounts.length - 1),
    activeIndexByFamily: {
      claude: clampInt(activeIndex, 0, accounts.length - 1),
      gemini: clampInt(activeIndex, 0, accounts.length - 1),
    },
  });
}

/**
 * Build a synthetic successful exchange result from an already stored account.
 *
 * @param account object - Stored account fields.
 * @returns Extract<AntigravityTokenExchangeResult, { type: "success" }> - Synthetic success payload.
 */
export function buildAuthSuccessFromStoredAccount(account: {
  refreshToken: string;
  projectId?: string;
  managedProjectId?: string;
  email?: string;
  isGcpTos?: boolean;
}): Extract<AntigravityTokenExchangeResult, { type: "success" }> {
  const refresh = formatRefreshParts({
    refreshToken: account.refreshToken,
    projectId: account.projectId,
    managedProjectId: account.managedProjectId,
    isGcpTos: account.isGcpTos,
  });

  return {
    type: "success",
    refresh,
    access: "",
    expires: 0,
    email: account.email,
    projectId: account.projectId ?? "",
  };
}
