import { describe, expect, it } from "vitest";

import { AccountManager, parseRateLimitReason } from "./accounts";
import type { AccountStorageV4 } from "./storage";

describe("rate-limit fallback gating", () => {
  it("parses quota exhaustion from quota-specific resource exhausted messages", () => {
    expect(parseRateLimitReason(undefined, "Resource has been exhausted (e.g. check quota).")).toBe("QUOTA_EXHAUSTED");
  });

  it("does not treat generic 429 resource exhausted text as model capacity", () => {
    expect(parseRateLimitReason(undefined, "resource exhausted", 429)).toBe("UNKNOWN");
  });

  it("treats 503 and 529 as model-capacity signals", () => {
    expect(parseRateLimitReason(undefined, "resource exhausted", 503)).toBe("MODEL_CAPACITY_EXHAUSTED");
    expect(parseRateLimitReason(undefined, "resource exhausted", 529)).toBe("MODEL_CAPACITY_EXHAUSTED");
  });

  it("only enables all-account fallback when every eligible account is quota exhausted", () => {
    const stored: AccountStorageV4 = {
      version: 4,
      accounts: [
        { refreshToken: "r1", projectId: "p1", addedAt: 1, lastUsed: 0 },
        { refreshToken: "r2", projectId: "p2", addedAt: 2, lastUsed: 0 },
      ],
      activeIndex: 0,
    };

    const manager = new AccountManager(undefined, stored);
    const [first, second] = manager.getAccounts();

    manager.markRateLimitedWithReason(first!, "gemini", "antigravity", "gemini-3-pro", "QUOTA_EXHAUSTED");
    manager.markRateLimitedWithReason(second!, "gemini", "antigravity", "gemini-3-pro", "RATE_LIMIT_EXCEEDED");

    expect(
      manager.areAllAccountsRateLimitedForReason("gemini", "antigravity", "QUOTA_EXHAUSTED", "gemini-3-pro"),
    ).toBe(false);

    manager.markRateLimitedWithReason(second!, "gemini", "antigravity", "gemini-3-pro", "QUOTA_EXHAUSTED");

    expect(
      manager.areAllAccountsRateLimitedForReason("gemini", "antigravity", "QUOTA_EXHAUSTED", "gemini-3-pro"),
    ).toBe(true);
  });
});
