import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { findLocalAntigravityAppRoot } from "./runtime-metadata";

type GoogleAuthModule = typeof import("google-auth-library");
type OAuth2ClientConstructor = GoogleAuthModule["OAuth2Client"];
type OAuth2ClientInstance = InstanceType<OAuth2ClientConstructor>;
type GoogleAuthNamespace = GoogleAuthModule & {
  default?: unknown;
  "module.exports"?: unknown;
};

let cachedOAuth2ClientConstructor: OAuth2ClientConstructor | null = null;
const require = createRequire(import.meta.url);

/**
 * Create a Bun-safe google-auth-library OAuth2 client instance.
 *
 * Params:
 * args: ConstructorParameters<OAuth2ClientConstructor> - OAuth client constructor arguments.
 *
 * Returns:
 * Promise<OAuth2ClientInstance> - Constructed OAuth2 client instance.
 */
export async function createGoogleOAuth2Client(
  ...args: ConstructorParameters<OAuth2ClientConstructor>
): Promise<OAuth2ClientInstance> {
  const OAuth2Client = await loadGoogleOAuth2ClientConstructor();
  return new OAuth2Client(...args);
}

function extractOAuth2ClientConstructor(mod: unknown): OAuth2ClientConstructor | null {
  const visited = new Set<unknown>();
  const queue: unknown[] = [mod];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || visited.has(current)) {
      continue;
    }
    visited.add(current);

    if (typeof current === "object" || typeof current === "function") {
      const record = current as Record<string, unknown>;
      const candidate = record.OAuth2Client;
      if (typeof candidate === "function") {
        return candidate as OAuth2ClientConstructor;
      }

      for (const key of ["default", "module.exports"]) {
        const nested = record[key];
        if (nested) {
          queue.push(nested);
        }
      }
    }
  }

  return null;
}

function candidateRequireBases(): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  const push = (value?: string | null) => {
    if (!value) {
      return;
    }
    const normalized = path.resolve(value);
    if (seen.has(normalized)) {
      return;
    }
    seen.add(normalized);
    result.push(normalized);
  };

  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  let cursor: string | undefined = currentDir;
  while (cursor) {
    if (existsSync(path.join(cursor, "node_modules", "google-auth-library", "package.json"))) {
      push(path.join(cursor, "package.json"));
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) {
      break;
    }
    cursor = parent;
  }

  const localAppRoot = findLocalAntigravityAppRoot();
  if (localAppRoot && existsSync(path.join(localAppRoot, "node_modules", "google-auth-library", "package.json"))) {
    push(path.join(localAppRoot, "product.json"));
  }

  const configuredAppRoot = process.env.OPENCODE_ANTIGRAVITY_APP_DIR?.trim();
  if (configuredAppRoot && existsSync(path.join(configuredAppRoot, "node_modules", "google-auth-library", "package.json"))) {
    push(path.join(configuredAppRoot, "package.json"));
  }

  push(fileURLToPath(import.meta.url));
  return result;
}

function candidateModuleEntries(): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  const push = (value?: string | null) => {
    if (!value) {
      return;
    }
    const normalized = path.resolve(value);
    if (!existsSync(normalized) || seen.has(normalized)) {
      return;
    }
    seen.add(normalized);
    result.push(normalized);
  };

  for (const base of candidateRequireBases()) {
    const directory = path.dirname(base);
    push(path.join(directory, "node_modules", "google-auth-library", "build", "src", "index.js"));
  }

  return result;
}

async function loadGoogleOAuth2ClientConstructor(): Promise<OAuth2ClientConstructor> {
  if (cachedOAuth2ClientConstructor) {
    return cachedOAuth2ClientConstructor;
  }

  const failureDetails: string[] = [];
  const directModule = (() => {
    try {
      return require("google-auth-library") as GoogleAuthNamespace;
    } catch (error) {
      failureDetails.push(`direct require: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  })();
  const directCtor = extractOAuth2ClientConstructor(directModule);
  if (directCtor) {
    cachedOAuth2ClientConstructor = directCtor;
    return cachedOAuth2ClientConstructor;
  }

  if (directModule) {
    failureDetails.push(`direct require keys: ${Object.keys(directModule).join(", ")}`);
  }

  try {
    const importedModule = (await import("google-auth-library")) as GoogleAuthNamespace;
    const importedCtor = extractOAuth2ClientConstructor(importedModule);
    if (importedCtor) {
      cachedOAuth2ClientConstructor = importedCtor;
      return cachedOAuth2ClientConstructor;
    }
    failureDetails.push(`dynamic import keys: ${Object.keys(importedModule).join(", ")}`);
  } catch (error) {
    failureDetails.push(`dynamic import: ${error instanceof Error ? error.message : String(error)}`);
  }

  for (const base of candidateRequireBases()) {
    try {
      const localRequire = createRequire(base);
      const requiredModule = localRequire("google-auth-library") as GoogleAuthNamespace;
      const requiredCtor = extractOAuth2ClientConstructor(requiredModule);
      if (requiredCtor) {
        cachedOAuth2ClientConstructor = requiredCtor;
        return cachedOAuth2ClientConstructor;
      }
      failureDetails.push(`require from ${base}: ${Object.keys(requiredModule).join(", ")}`);
    } catch (error) {
      failureDetails.push(`require from ${base}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  for (const entry of candidateModuleEntries()) {
    try {
      const importedModule = (await import(pathToFileURL(entry).href)) as GoogleAuthNamespace;
      const importedCtor = extractOAuth2ClientConstructor(importedModule);
      if (importedCtor) {
        cachedOAuth2ClientConstructor = importedCtor;
        return cachedOAuth2ClientConstructor;
      }
      failureDetails.push(`import ${entry}: ${Object.keys(importedModule).join(", ")}`);
    } catch (error) {
      failureDetails.push(`import ${entry}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  throw new Error(`google-auth-library did not expose OAuth2Client. ${failureDetails.join(" | ")}`);
}
