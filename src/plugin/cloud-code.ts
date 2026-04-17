import {
  ANTIGRAVITY_ENDPOINT_AUTOPUSH,
  ANTIGRAVITY_ENDPOINT_DAILY,
  ANTIGRAVITY_ENDPOINT_DAILY_SANDBOX,
  ANTIGRAVITY_ENDPOINT_PROD,
} from "../constants";

export interface CloudCodeRouteState {
  isGcpTos?: boolean;
  usesGcpTos?: boolean;
  cloudCodeUrlOverride?: string;
}

function uniqueEndpoints(endpoints: string[]): string[] {
  const result: string[] = [];
  for (const endpoint of endpoints) {
    const trimmed = endpoint.trim();
    if (!trimmed || result.includes(trimmed)) {
      continue;
    }
    result.push(trimmed);
  }
  return result;
}

export function resolveCloudCodeBaseUrl(state?: CloudCodeRouteState): string {
  const override = state?.cloudCodeUrlOverride?.trim();
  if (override) {
    return override;
  }

  if (state?.isGcpTos === true || state?.usesGcpTos === true || state?.usesGcpTos === undefined) {
    return ANTIGRAVITY_ENDPOINT_PROD;
  }

  return ANTIGRAVITY_ENDPOINT_DAILY;
}

export function getCloudCodeEndpointOrder(state?: CloudCodeRouteState): string[] {
  const primary = resolveCloudCodeBaseUrl(state);

  if (primary === ANTIGRAVITY_ENDPOINT_PROD) {
    return uniqueEndpoints([
      primary,
      ANTIGRAVITY_ENDPOINT_DAILY,
      ANTIGRAVITY_ENDPOINT_DAILY_SANDBOX,
      ANTIGRAVITY_ENDPOINT_AUTOPUSH,
    ]);
  }

  return uniqueEndpoints([
    primary,
    ANTIGRAVITY_ENDPOINT_PROD,
    ANTIGRAVITY_ENDPOINT_DAILY_SANDBOX,
    ANTIGRAVITY_ENDPOINT_AUTOPUSH,
  ]);
}
