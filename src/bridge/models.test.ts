import { describe, expect, it } from "vitest";

import { listAntigravityBridgeModels, resolveAntigravityBridgeRequestedModel } from "./models";

describe("bridge model catalog", () => {
  it("includes the live Antigravity selector labels", () => {
    const models = listAntigravityBridgeModels();

    expect(models.find((model) => model.name === "Claude Sonnet 4.6 (Thinking)")?.requestedModel).toBe("MODEL_PLACEHOLDER_M35");
    expect(models.find((model) => model.name === "Claude Opus 4.6 (Thinking)")?.requestedModel).toBe("MODEL_PLACEHOLDER_M26");
    expect(models.find((model) => model.name === "Gemini 3.1 Pro (High)")?.requestedModel).toBe("MODEL_PLACEHOLDER_M37");
    expect(models.find((model) => model.name === "Gemini 3.1 Pro (Low)")?.requestedModel).toBe("MODEL_PLACEHOLDER_M36");
    expect(models.find((model) => model.name === "Gemini 3 Flash")?.requestedModel).toBe("MODEL_PLACEHOLDER_M47");
    expect(models.find((model) => model.name === "GPT-OSS 120B (Medium)")?.requestedModel).toBe("OPENAI_GPT_OSS_120B_MEDIUM");
  });
});

describe("resolveAntigravityBridgeRequestedModel", () => {
  it("resolves live numeric selector ids into wire enum names", () => {
    expect(resolveAntigravityBridgeRequestedModel("1026")).toBe("MODEL_PLACEHOLDER_M26");
    expect(resolveAntigravityBridgeRequestedModel("1035")).toBe("MODEL_PLACEHOLDER_M35");
    expect(resolveAntigravityBridgeRequestedModel("1036")).toBe("MODEL_PLACEHOLDER_M36");
    expect(resolveAntigravityBridgeRequestedModel("1037")).toBe("MODEL_PLACEHOLDER_M37");
    expect(resolveAntigravityBridgeRequestedModel("1047")).toBe("MODEL_PLACEHOLDER_M47");
    expect(resolveAntigravityBridgeRequestedModel("342")).toBe("OPENAI_GPT_OSS_120B_MEDIUM");
  });

  it("resolves selector labels and shorthand placeholder names", () => {
    expect(resolveAntigravityBridgeRequestedModel("Claude Opus 4.6 (Thinking)")).toBe("MODEL_PLACEHOLDER_M26");
    expect(resolveAntigravityBridgeRequestedModel("Claude Sonnet 4.6 (Thinking)")).toBe("MODEL_PLACEHOLDER_M35");
    expect(resolveAntigravityBridgeRequestedModel("m26")).toBe("MODEL_PLACEHOLDER_M26");
    expect(resolveAntigravityBridgeRequestedModel("PLACEHOLDER_M35")).toBe("MODEL_PLACEHOLDER_M35");
  });

  it("keeps real Antigravity enum names unchanged", () => {
    expect(resolveAntigravityBridgeRequestedModel("OPENAI_GPT_OSS_120B_MEDIUM")).toBe("OPENAI_GPT_OSS_120B_MEDIUM");
    expect(resolveAntigravityBridgeRequestedModel("CLAUDE_4_5_SONNET")).toBe("CLAUDE_4_5_SONNET");
  });
});
