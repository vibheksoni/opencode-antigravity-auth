import { describe, expect, it } from "vitest";

import { buildDiscoveredModels } from "./model-catalog";

describe("buildDiscoveredModels", () => {
  it("normalizes discovered Antigravity models into provider definitions", () => {
    const result = buildDiscoveredModels(
      {
        models: {
          "gemini-3-pro-low": {
            displayName: "Gemini 3 Pro Low",
            maxTokens: 1234,
            maxOutputTokens: 4321,
            supportsImages: true,
            supportedMimeTypes: {
              "application/pdf": true,
              "image/png": true,
            },
          },
          "claude-sonnet-4-6": {
            displayName: "Claude Sonnet 4.6",
            maxTokens: 200000,
            maxOutputTokens: 64000,
          },
        },
        deprecatedModelIds: {
          "claude-sonnet-4-6-old": { newModelId: "claude-sonnet-4-6" },
        },
      },
      {
        models: {
          "antigravity-gemini-3-flash": {
            api: { id: "gemini-3-flash", url: "https://example.test", npm: "@ai-sdk/google" },
            cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
            limit: { context: 1, output: 1 },
            status: "active",
            headers: {},
            options: {},
            release_date: "",
          },
          "antigravity-claude-sonnet-4-6": {
            api: { id: "claude-sonnet-4-6", url: "https://example.test", npm: "@ai-sdk/google" },
            cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
            limit: { context: 1, output: 1 },
            status: "active",
            headers: {},
            options: {},
            release_date: "",
          },
        },
      },
    );

    expect(result["antigravity-gemini-3-pro-low"]).toMatchObject({
      name: "Gemini 3 Pro Low (Antigravity)",
      api: {
        id: "gemini-3-pro-low",
        url: "https://example.test",
        npm: "@ai-sdk/google",
      },
      limit: {
        context: 1234,
        output: 4321,
      },
      capabilities: {
        attachment: true,
        input: {
          image: true,
          pdf: true,
        },
      },
      cost: {
        input: 0,
        output: 0,
      },
    });

    expect(result["antigravity-claude-sonnet-4-6"]).toMatchObject({
      name: "Claude Sonnet 4.6 (Antigravity)",
      api: {
        id: "claude-sonnet-4-6",
      },
      limit: {
        context: 200000,
        output: 64000,
      },
    });
  });
});
