import type { AccountQuotaResult, GeminiCliQuotaSummary, QuotaSummary } from "./quota";
import type { AccountStorageV4 } from "./storage";

function formatWaitTime(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  if (minutes > 0) return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
  return `${seconds}s`;
}

function formatReset(resetTime?: string): string {
  if (!resetTime) return "";
  const ms = Date.parse(resetTime) - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return " (resetting)";
  return ` (resets in ${formatWaitTime(ms)})`;
}

function formatRemaining(remaining?: number): string {
  if (typeof remaining !== "number") return "unknown";
  return `${Math.round(Math.max(0, Math.min(1, remaining)) * 100)}%`;
}

function printGeminiCliQuota(quota: GeminiCliQuotaSummary | undefined): void {
  console.log("Gemini CLI quota:");
  if (!quota || quota.models.length === 0) {
    console.log(`- ${quota?.error || "No Gemini CLI quota available"}`);
    return;
  }

  for (const model of quota.models) {
    console.log(`- ${model.modelId}: ${formatRemaining(model.remainingFraction)}${formatReset(model.resetTime)}`);
  }
}

function printAntigravityQuota(quota: QuotaSummary | undefined): void {
  console.log("Antigravity quota:");
  if (!quota || Object.keys(quota.groups).length === 0) {
    console.log(`- ${quota?.error || "No quota information available"}`);
    return;
  }

  const entries = [
    { name: "Claude", data: quota.groups.claude },
    { name: "Gemini 3 Pro", data: quota.groups["gemini-pro"] },
    { name: "Gemini 3 Flash", data: quota.groups["gemini-flash"] },
  ].filter((entry): entry is { name: string; data: NonNullable<typeof entry.data> } => Boolean(entry.data));

  for (const entry of entries) {
    console.log(`- ${entry.name}: ${formatRemaining(entry.data.remainingFraction)}${formatReset(entry.data.resetTime)}`);
  }
}

/**
 * Print a plain-text quota report and update cached quota data in storage.
 *
 * @param results AccountQuotaResult[] - Quota check results.
 * @param storage AccountStorageV4 - Current account storage.
 * @returns boolean - Whether storage was updated.
 */
export function printQuotaCheckResults(results: AccountQuotaResult[], storage: AccountStorageV4): boolean {
  let storageUpdated = false;

  console.log("\nChecking quotas for all accounts...\n");

  for (const result of results) {
    const label = result.email || `Account ${result.index + 1}`;
    const disabled = result.disabled ? " (disabled)" : "";

    console.log("------------------------------------------------------------");
    console.log(`${label}${disabled}`);
    console.log("------------------------------------------------------------");

    if (result.status === "error") {
      console.log(`Error: ${result.error}\n`);
      continue;
    }

    printGeminiCliQuota(result.geminiCliQuota);
    console.log("");
    printAntigravityQuota(result.quota);
    console.log("");

    if (result.quota?.groups) {
      const account = storage.accounts[result.index];
      if (account) {
        account.cachedQuota = result.quota.groups;
        account.cachedQuotaUpdatedAt = Date.now();
        storageUpdated = true;
      }
    }

    if (result.updatedAccount) {
      storage.accounts[result.index] = {
        ...result.updatedAccount,
        cachedQuota: result.quota?.groups,
        cachedQuotaUpdatedAt: Date.now(),
      };
      storageUpdated = true;
    }
  }

  console.log("");
  return storageUpdated;
}
