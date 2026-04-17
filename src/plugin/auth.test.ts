import { beforeEach, describe, expect, it, vi } from "vitest";

import { isOAuthAuth, parseRefreshParts, formatRefreshParts, accessTokenExpired } from "./auth";
import type { OAuthAuthDetails, ApiKeyAuthDetails } from "./types";

describe("isOAuthAuth", () => {
  it("returns true for oauth auth type", () => {
    const auth: OAuthAuthDetails = {
      type: "oauth",
      refresh: "token|project",
      access: "access-token",
      expires: Date.now() + 3600000,
    };
    expect(isOAuthAuth(auth)).toBe(true);
  });

  it("returns false for api_key auth type", () => {
    const auth: ApiKeyAuthDetails = {
      type: "api_key",
      key: "some-api-key",
    };
    expect(isOAuthAuth(auth)).toBe(false);
  });
});

describe("parseRefreshParts", () => {
  it("parses refresh token with all parts", () => {
    const result = parseRefreshParts("refreshToken|projectId|managedProjectId");
    expect(result).toEqual({
      refreshToken: "refreshToken",
      projectId: "projectId",
      managedProjectId: "managedProjectId",
      isGcpTos: false,
    });
  });

  it("parses refresh token with only refresh and project", () => {
    const result = parseRefreshParts("refreshToken|projectId");
    expect(result).toEqual({
      refreshToken: "refreshToken",
      projectId: "projectId",
      managedProjectId: undefined,
      isGcpTos: false,
    });
  });

  it("parses refresh token with only refresh token", () => {
    const result = parseRefreshParts("refreshToken");
    expect(result).toEqual({
      refreshToken: "refreshToken",
      projectId: undefined,
      managedProjectId: undefined,
      isGcpTos: false,
    });
  });

  it("handles empty string", () => {
    const result = parseRefreshParts("");
    expect(result).toEqual({
      refreshToken: "",
      projectId: undefined,
      managedProjectId: undefined,
      isGcpTos: false,
    });
  });

  it("handles empty parts", () => {
    const result = parseRefreshParts("refreshToken||managedProjectId");
    expect(result).toEqual({
      refreshToken: "refreshToken",
      projectId: undefined,
      managedProjectId: "managedProjectId",
      isGcpTos: false,
    });
  });

  it("handles undefined/null-like input", () => {
    // @ts-expect-error - testing edge case
    const result = parseRefreshParts(undefined);
    expect(result).toEqual({
      refreshToken: "",
      projectId: undefined,
      managedProjectId: undefined,
      isGcpTos: false,
    });
  });

  it("parses gcp tos flag from the fourth segment", () => {
    const result = parseRefreshParts("refreshToken|projectId|managedProjectId|1");
    expect(result).toEqual({
      refreshToken: "refreshToken",
      projectId: "projectId",
      managedProjectId: "managedProjectId",
      isGcpTos: true,
    });
  });
});

describe("formatRefreshParts", () => {
  it("formats all parts", () => {
    const result = formatRefreshParts({
      refreshToken: "refreshToken",
      projectId: "projectId",
      managedProjectId: "managedProjectId",
    });
    expect(result).toBe("refreshToken|projectId|managedProjectId");
  });

  it("formats gcp tos flag as the fourth segment", () => {
    const result = formatRefreshParts({
      refreshToken: "refreshToken",
      projectId: "projectId",
      managedProjectId: "managedProjectId",
      isGcpTos: true,
    });
    expect(result).toBe("refreshToken|projectId|managedProjectId|1");
  });

  it("formats without managed project id", () => {
    const result = formatRefreshParts({
      refreshToken: "refreshToken",
      projectId: "projectId",
    });
    expect(result).toBe("refreshToken|projectId");
  });

  it("formats without project id but with managed project id", () => {
    const result = formatRefreshParts({
      refreshToken: "refreshToken",
      managedProjectId: "managedProjectId",
    });
    expect(result).toBe("refreshToken||managedProjectId");
  });

  it("formats with only refresh token", () => {
    const result = formatRefreshParts({
      refreshToken: "refreshToken",
    });
    expect(result).toBe("refreshToken|");
  });

  it("round-trips correctly with parseRefreshParts", () => {
    const original = {
      refreshToken: "rt123",
      projectId: "proj456",
      managedProjectId: "managed789",
      isGcpTos: true,
    };
    const formatted = formatRefreshParts(original);
    const parsed = parseRefreshParts(formatted);
    expect(parsed).toEqual(original);
  });
});

describe("accessTokenExpired", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it("returns true when access token is missing", () => {
    const auth: OAuthAuthDetails = {
      type: "oauth",
      refresh: "token",
      access: undefined,
      expires: Date.now() + 3600000,
    };
    expect(accessTokenExpired(auth)).toBe(true);
  });

  it("returns true when expires is missing", () => {
    const auth: OAuthAuthDetails = {
      type: "oauth",
      refresh: "token",
      access: "access-token",
      expires: undefined,
    };
    expect(accessTokenExpired(auth)).toBe(true);
  });

  it("returns true when token is expired", () => {
    const auth: OAuthAuthDetails = {
      type: "oauth",
      refresh: "token",
      access: "access-token",
      expires: Date.now() - 1000, // expired 1 second ago
    };
    expect(accessTokenExpired(auth)).toBe(true);
  });

  it("returns true when token expires within buffer period (60 seconds)", () => {
    const auth: OAuthAuthDetails = {
      type: "oauth",
      refresh: "token",
      access: "access-token",
      expires: Date.now() + 30000, // expires in 30 seconds (within 60s buffer)
    };
    expect(accessTokenExpired(auth)).toBe(true);
  });

  it("returns false when token is valid and outside buffer period", () => {
    const auth: OAuthAuthDetails = {
      type: "oauth",
      refresh: "token",
      access: "access-token",
      expires: Date.now() + 120000, // expires in 2 minutes
    };
    expect(accessTokenExpired(auth)).toBe(false);
  });

  it("returns false when token expires exactly at buffer boundary", () => {
    const auth: OAuthAuthDetails = {
      type: "oauth",
      refresh: "token",
      access: "access-token",
      expires: Date.now() + 60001, // expires just outside the 60s buffer
    };
    expect(accessTokenExpired(auth)).toBe(false);
  });
});
