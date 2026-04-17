import {
  getAntigravityHeaders,
  getAntigravityIDEMetadata,
  ANTIGRAVITY_DEFAULT_PROJECT_ID,
} from "../constants";
import { formatRefreshParts, parseRefreshParts } from "./auth";
import { getCloudCodeEndpointOrder, type CloudCodeRouteState } from "./cloud-code";
import { createLogger } from "./logger";
import type { OAuthAuthDetails, ProjectContextResult } from "./types";

const log = createLogger("project");

const projectContextResultCache = new Map<string, ProjectContextResult>();
const projectContextPendingCache = new Map<string, Promise<ProjectContextResult>>();

interface AntigravityUserTier {
  id?: string;
  isDefault?: boolean;
  userDefinedCloudaicompanionProject?: boolean;
}

interface LoadCodeAssistPayload {
  cloudaicompanionProject?: string | { id?: string };
  currentTier?: {
    id?: string;
  };
  paidTier?: {
    id?: string;
    usesGcpTos?: boolean;
  };
  allowedTiers?: AntigravityUserTier[];
}

interface OnboardUserPayload {
  name?: string;
  done?: boolean;
  response?: {
    cloudaicompanionProject?: {
      id?: string;
    };
  };
}

function buildMetadata(_projectId?: string): Record<string, string> {
  return getAntigravityIDEMetadata();
}

/**
 * Selects the default tier ID from the allowed tiers list.
 */
function getDefaultTierId(allowedTiers?: AntigravityUserTier[]): string | undefined {
  if (!allowedTiers || allowedTiers.length === 0) {
    return undefined;
  }
  for (const tier of allowedTiers) {
    if (tier?.isDefault) {
      return tier.id;
    }
  }
  return allowedTiers[0]?.id;
}

/**
 * Promise-based delay utility.
 */
function wait(ms: number): Promise<void> {
  return new Promise(function (resolve) {
    setTimeout(resolve, ms);
  });
}

/**
 * Extracts the cloudaicompanion project id from loadCodeAssist responses.
 */
function extractManagedProjectId(payload: LoadCodeAssistPayload | null): string | undefined {
  if (!payload) {
    return undefined;
  }
  if (typeof payload.cloudaicompanionProject === "string") {
    return payload.cloudaicompanionProject;
  }
  if (payload.cloudaicompanionProject && typeof payload.cloudaicompanionProject.id === "string") {
    return payload.cloudaicompanionProject.id;
  }
  return undefined;
}

/**
 * Generates a cache key for project context based on refresh token.
 */
function getCacheKey(auth: OAuthAuthDetails): string | undefined {
  const refresh = auth.refresh?.trim();
  return refresh ? refresh : undefined;
}

/**
 * Clears cached project context results and pending promises, globally or for a refresh key.
 */
export function invalidateProjectContextCache(refresh?: string): void {
  if (!refresh) {
    projectContextPendingCache.clear();
    projectContextResultCache.clear();
    return;
  }
  projectContextPendingCache.delete(refresh);
  projectContextResultCache.delete(refresh);
}

/**
 * Loads managed project information for the given access token and optional project.
 */
export async function loadManagedProject(
  accessToken: string,
  projectId?: string,
  routeState?: CloudCodeRouteState,
): Promise<LoadCodeAssistPayload | null> {
  const metadata = buildMetadata(projectId);
  const requestBody: Record<string, unknown> = { metadata };
  if (projectId?.trim()) {
    requestBody.cloudaicompanionProject = projectId.trim();
  }

  const loadHeaders: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${accessToken}`,
    "User-Agent": getAntigravityHeaders()["User-Agent"],
  };

  for (const baseEndpoint of getCloudCodeEndpointOrder(routeState)) {
    try {
      const response = await fetch(
        `${baseEndpoint}/v1internal:loadCodeAssist`,
        {
          method: "POST",
          headers: loadHeaders,
          body: JSON.stringify(requestBody),
        },
      );

      if (!response.ok) {
        continue;
      }

      let payload = (await response.json()) as LoadCodeAssistPayload;

      if (!payload.paidTier && extractManagedProjectId(payload)) {
        const secondResponse = await fetch(
          `${baseEndpoint}/v1internal:loadCodeAssist`,
          {
            method: "POST",
            headers: loadHeaders,
            body: JSON.stringify(requestBody),
          },
        );

        if (secondResponse.ok) {
          payload = (await secondResponse.json()) as LoadCodeAssistPayload;
        }
      }

      return payload;
    } catch (error) {
      log.debug("Failed to load managed project", { endpoint: baseEndpoint, error: String(error) });
      continue;
    }
  }

  return null;
}


/**
 * Onboards a managed project for the user, optionally retrying until completion.
 */
export async function onboardManagedProject(
  accessToken: string,
  tierId: string,
  projectId?: string,
  routeState?: CloudCodeRouteState,
  attempts = 10,
  delayMs = 5000,
): Promise<string | undefined> {
  const metadata = buildMetadata(projectId);
  const requestBody: Record<string, unknown> = {
    tierId,
    metadata,
  };
  if (projectId?.trim()) {
    requestBody.cloudaicompanionProject = projectId.trim();
  }

  for (const baseEndpoint of getCloudCodeEndpointOrder(routeState)) {
    try {
      const response = await fetch(
        `${baseEndpoint}/v1internal:onboardUser`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${accessToken}`,
            "User-Agent": getAntigravityHeaders()["User-Agent"],
          },
          body: JSON.stringify(requestBody),
        },
      );

      if (!response.ok) {
        continue;
      }

      let payload = (await response.json()) as OnboardUserPayload;
      let managedProjectId = payload.response?.cloudaicompanionProject?.id;

      if (payload.done && managedProjectId) {
        return managedProjectId;
      }

      if (payload.done && projectId) {
        return projectId;
      }

      if (!payload.name) {
        continue;
      }

      for (let attempt = 0; attempt < attempts; attempt += 1) {
        const pollResponse = await fetch(
          `${baseEndpoint}/v1internal/${payload.name}`,
          {
            method: "GET",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${accessToken}`,
              "User-Agent": getAntigravityHeaders()["User-Agent"],
            },
          },
        );

        if (!pollResponse.ok) {
          break;
        }

        payload = (await pollResponse.json()) as OnboardUserPayload;
        managedProjectId = payload.response?.cloudaicompanionProject?.id;

        if (payload.done && managedProjectId) {
          return managedProjectId;
        }

        if (payload.done && projectId) {
          return projectId;
        }

        await wait(delayMs);
      }
    } catch (error) {
      log.debug("Failed to onboard managed project", { endpoint: baseEndpoint, error: String(error) });
      continue;
    }
  }

  return undefined;
}

/**
 * Resolves an effective project ID for the current auth state, caching results per refresh token.
 */
export async function ensureProjectContext(auth: OAuthAuthDetails): Promise<ProjectContextResult> {
  const accessToken = auth.access;
  if (!accessToken) {
    return { auth, effectiveProjectId: "" };
  }

  const cacheKey = getCacheKey(auth);
  if (cacheKey) {
    const cached = projectContextResultCache.get(cacheKey);
    if (cached) {
      return cached;
    }
    const pending = projectContextPendingCache.get(cacheKey);
    if (pending) {
      return pending;
    }
  }

  const resolveContext = async (): Promise<ProjectContextResult> => {
    const parts = parseRefreshParts(auth.refresh);
    if (parts.managedProjectId) {
      return {
        auth,
        effectiveProjectId: parts.managedProjectId,
        routeState: { usesGcpTos: undefined },
      };
    }

    const fallbackProjectId = ANTIGRAVITY_DEFAULT_PROJECT_ID;
    const persistManagedProject = async (
      managedProjectId: string,
      routeState?: CloudCodeRouteState,
    ): Promise<ProjectContextResult> => {
      const updatedAuth: OAuthAuthDetails = {
        ...auth,
        refresh: formatRefreshParts({
          refreshToken: parts.refreshToken,
          projectId: parts.projectId,
          managedProjectId,
          isGcpTos: parts.isGcpTos,
        }),
      };

      return {
        auth: updatedAuth,
        effectiveProjectId: managedProjectId,
        routeState,
      };
    };

    // Try to resolve a managed project from Antigravity if possible.
    const loadPayload = await loadManagedProject(accessToken, parts.projectId ?? fallbackProjectId);
    const routeState: CloudCodeRouteState = {
      usesGcpTos: loadPayload?.paidTier?.usesGcpTos,
    };
    const resolvedManagedProjectId = extractManagedProjectId(loadPayload);

    if (resolvedManagedProjectId) {
      return persistManagedProject(resolvedManagedProjectId, routeState);
    }

    // No managed project found - try to auto-provision one via onboarding.
    // This handles accounts that were added before managed project provisioning was required.
    const tierId = getDefaultTierId(loadPayload?.allowedTiers) ?? "free-tier";
    log.debug("Auto-provisioning managed project", { tierId, projectId: parts.projectId });
    
    const provisionedProjectId = await onboardManagedProject(
      accessToken,
      tierId,
      parts.projectId,
      routeState,
    );

    if (provisionedProjectId) {
      log.debug("Successfully provisioned managed project", { provisionedProjectId });
      return persistManagedProject(provisionedProjectId, routeState);
    }

    log.warn("Failed to provision managed project - account may not work correctly", {
      hasProjectId: !!parts.projectId,
    });

    if (parts.projectId) {
      return { auth, effectiveProjectId: parts.projectId, routeState };
    }

    // No project id present in auth; fall back to the hardcoded id for requests.
    return { auth, effectiveProjectId: fallbackProjectId, routeState };
  };

  if (!cacheKey) {
    return resolveContext();
  }

  const promise = resolveContext()
    .then((result) => {
      const nextKey = getCacheKey(result.auth) ?? cacheKey;
      projectContextPendingCache.delete(cacheKey);
      projectContextResultCache.set(nextKey, result);
      if (nextKey !== cacheKey) {
        projectContextResultCache.delete(cacheKey);
      }
      return result;
    })
    .catch((error) => {
      projectContextPendingCache.delete(cacheKey);
      throw error;
    });

  projectContextPendingCache.set(cacheKey, promise);
  return promise;
}
