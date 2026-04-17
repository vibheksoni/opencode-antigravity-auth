import { describe, expect, it } from "vitest";

import {
  getCloudCodeEndpointOrder,
  resolveCloudCodeBaseUrl,
} from "./cloud-code";

describe("cloud-code routing", () => {
  it("defaults to production when route state is unknown", () => {
    expect(resolveCloudCodeBaseUrl()).toBe("https://cloudcode-pa.googleapis.com");
  });

  it("uses the daily app endpoint for non-GCP ToS routes", () => {
    expect(resolveCloudCodeBaseUrl({ isGcpTos: false, usesGcpTos: false })).toBe(
      "https://daily-cloudcode-pa.googleapis.com",
    );
  });

  it("orders fallbacks from production first", () => {
    expect(getCloudCodeEndpointOrder()).toEqual([
      "https://cloudcode-pa.googleapis.com",
      "https://daily-cloudcode-pa.googleapis.com",
      "https://daily-cloudcode-pa.sandbox.googleapis.com",
      "https://autopush-cloudcode-pa.sandbox.googleapis.com",
    ]);
  });

  it("orders fallbacks from the daily endpoint when the route is not GCP ToS", () => {
    expect(getCloudCodeEndpointOrder({ isGcpTos: false, usesGcpTos: false })).toEqual([
      "https://daily-cloudcode-pa.googleapis.com",
      "https://cloudcode-pa.googleapis.com",
      "https://daily-cloudcode-pa.sandbox.googleapis.com",
      "https://autopush-cloudcode-pa.sandbox.googleapis.com",
    ]);
  });
});
