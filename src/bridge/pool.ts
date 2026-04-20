export interface BridgePoolCandidate {
  key: string;
}

export interface BridgePoolSelection {
  selectedKey: string | null;
  nextCursor: number;
}

export function selectBridgePoolCandidate(
  candidates: BridgePoolCandidate[],
  cursor: number,
  preferredKey?: string,
  excludedKeys: string[] = [],
): BridgePoolSelection {
  const filtered = candidates.filter((candidate) => !excludedKeys.includes(candidate.key));
  if (filtered.length === 0) {
    return {
      selectedKey: null,
      nextCursor: 0,
    };
  }

  if (preferredKey) {
    const preferred = filtered.find((candidate) => candidate.key === preferredKey);
    if (preferred) {
      return {
        selectedKey: preferred.key,
        nextCursor: cursor,
      };
    }
  }

  const normalizedCursor = cursor < 0 ? 0 : cursor % filtered.length;
  const selected = filtered[normalizedCursor] ?? filtered[0] ?? null;

  return {
    selectedKey: selected?.key ?? null,
    nextCursor: (normalizedCursor + 1) % filtered.length,
  };
}

export function isBridgeRotationError(message: string | undefined): boolean {
  const normalized = message?.toLowerCase() ?? "";
  if (!normalized) {
    return false;
  }

  return (
    normalized.includes("timed out") ||
    normalized.includes("timeout") ||
    normalized.includes("quota") ||
    normalized.includes("rate limit") ||
    normalized.includes("resource exhausted") ||
    normalized.includes("resource_exhausted") ||
    normalized.includes("capacity") ||
    normalized.includes("token source") ||
    normalized.includes("state syncing") ||
    normalized.includes("load code assist") ||
    normalized.includes("invalid_grant") ||
    normalized.includes("overloaded")
  );
}
