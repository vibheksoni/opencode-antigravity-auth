import { describe, it, expect } from "vitest"
import {
  GEMINI_CLI_HEADERS,
  getRandomizedHeaders,
  type HeaderSet,
} from "./constants.ts"

describe("GEMINI_CLI_HEADERS", () => {
  it("matches Code Assist headers from opencode-gemini-auth", () => {
    expect(GEMINI_CLI_HEADERS).toEqual({
      "User-Agent": "google-api-nodejs-client/9.15.1",
      "X-Goog-Api-Client": "gl-node/22.17.0",
      "Client-Metadata": "ideType=IDE_UNSPECIFIED,platform=PLATFORM_UNSPECIFIED,pluginType=GEMINI",
    })
  })
})

describe("getRandomizedHeaders", () => {
  describe("gemini-cli style", () => {
    it("returns static Code Assist headers", () => {
      const headers = getRandomizedHeaders("gemini-cli", "gemini-2.5-pro")
      expect(headers).toEqual({
        "User-Agent": "google-api-nodejs-client/9.15.1",
        "X-Goog-Api-Client": "gl-node/22.17.0",
        "Client-Metadata": "ideType=IDE_UNSPECIFIED,platform=PLATFORM_UNSPECIFIED,pluginType=GEMINI",
      })
    })

    it("ignores requested model and keeps static User-Agent", () => {
      const headers = getRandomizedHeaders("gemini-cli", "gemini-3-pro-preview")
      expect(headers["User-Agent"]).toBe("google-api-nodejs-client/9.15.1")
    })
  })

  describe("antigravity style", () => {
    it("returns only the runtime User-Agent header", () => {
      const headers = getRandomizedHeaders("antigravity")
      expect(headers["User-Agent"]).toBeDefined()
      expect(headers["X-Goog-Api-Client"]).toBeUndefined()
      expect(headers["Client-Metadata"]).toBeUndefined()
    })

    it("returns User-Agent in antigravity format", () => {
      const headers = getRandomizedHeaders("antigravity")
      expect(headers["User-Agent"]).toMatch(/^antigravity\//)
    })

    it("uses a deterministic runtime platform shape", () => {
      const headers = getRandomizedHeaders("antigravity")
      expect(headers["User-Agent"]).toMatch(/ (windows|darwin|linux)\//)
    })
  })
})

describe("HeaderSet type", () => {
  it("allows omitting X-Goog-Api-Client and Client-Metadata", () => {
    const headers: HeaderSet = {
      "User-Agent": "test",
    }
    expect(headers["User-Agent"]).toBe("test")
    expect(headers["X-Goog-Api-Client"]).toBeUndefined()
    expect(headers["Client-Metadata"]).toBeUndefined()
  })

  it("allows including all three headers", () => {
    const headers: HeaderSet = {
      "User-Agent": "test",
      "X-Goog-Api-Client": "test-client",
      "Client-Metadata": "test-metadata",
    }
    expect(headers["User-Agent"]).toBe("test")
    expect(headers["X-Goog-Api-Client"]).toBe("test-client")
    expect(headers["Client-Metadata"]).toBe("test-metadata")
  })
})
