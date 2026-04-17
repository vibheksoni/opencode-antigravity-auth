import type { ExistingAccountInfo } from "./cli";
import type { AccountMetadataV3, AccountStorageV4 } from "./storage";

/**
 * Derive the display status for an account in the CLI auth menu.
 *
 * @param account AccountMetadataV3 - Stored account record.
 * @param now number - Current timestamp in milliseconds.
 * @returns ExistingAccountInfo["status"] - Derived display status.
 */
export function deriveExistingAccountStatus(
  account: AccountMetadataV3,
  now: number,
): ExistingAccountInfo["status"] {
  if (account.verificationRequired) {
    return "verification-required";
  }

  const rateLimits = account.rateLimitResetTimes;
  if (rateLimits) {
    const isRateLimited = Object.values(rateLimits).some(
      (resetTime) => typeof resetTime === "number" && resetTime > now,
    );
    if (isRateLimited) {
      return "rate-limited";
    }
  }

  if (account.coolingDownUntil && account.coolingDownUntil > now) {
    return "rate-limited";
  }

  return "active";
}

/**
 * Convert storage accounts into the CLI menu representation.
 *
 * @param storage AccountStorageV4 - Current stored accounts.
 * @returns ExistingAccountInfo[] - Menu-ready account rows.
 */
export function buildExistingAccountInfos(storage: AccountStorageV4): ExistingAccountInfo[] {
  const now = Date.now();
  return storage.accounts.map((account, index) => ({
    email: account.email,
    index,
    addedAt: account.addedAt,
    lastUsed: account.lastUsed,
    status: deriveExistingAccountStatus(account, now),
    isCurrentAccount: index === (storage.activeIndex ?? 0),
    enabled: account.enabled !== false,
  }));
}
