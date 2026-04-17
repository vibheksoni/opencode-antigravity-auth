import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  getAntigravityClientId,
  getAntigravityClientSecret,
  getAntigravityVersion,
  setAntigravityOAuthClients,
  setAntigravityVersion,
} from "../constants";
import { createLogger } from "./logger";
import { initAntigravityVersion } from "./version";

const log = createLogger("runtime-metadata");

interface LocalAppMetadata {
  source: string;
  root: string;
  version?: string;
  clientId?: string;
  clientSecret?: string;
  gcpTosClientId?: string;
  gcpTosClientSecret?: string;
}

function versionParts(version?: string): number[] {
  return (version ?? "")
    .split(".")
    .map((item) => Number.parseInt(item, 10))
    .filter((item) => Number.isFinite(item));
}

function compareVersions(left?: string, right?: string): number {
  const leftParts = versionParts(left);
  const rightParts = versionParts(right);
  const length = Math.max(leftParts.length, rightParts.length);
  for (let i = 0; i < length; i += 1) {
    const l = leftParts[i] ?? 0;
    const r = rightParts[i] ?? 0;
    if (l > r) return 1;
    if (l < r) return -1;
  }
  return 0;
}

function candidateRoots(): string[] {
  const roots = new Set<string>();
  const envRoot = process.env.OPENCODE_ANTIGRAVITY_APP_DIR?.trim();
  if (envRoot) {
    roots.add(envRoot);
  }

  roots.add(path.join(process.cwd(), ".ignore", "antigravity-app"));

  const configDir = process.env.OPENCODE_CONFIG_DIR?.trim();
  if (configDir) {
    roots.add(path.join(path.dirname(configDir), ".ignore", "antigravity-app"));
  }

  const localPrograms = process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, "Programs", "Antigravity")
    : path.join(os.homedir(), "AppData", "Local", "Programs", "Antigravity");
  roots.add(localPrograms);
  roots.add(path.join(localPrograms, "resources", "app"));

  return [...roots];
}

function normalizeRoot(candidate: string): string | null {
  const trimmed = candidate.trim();
  if (!trimmed) return null;

  const fileCandidate = path.extname(trimmed).toLowerCase();
  if (fileCandidate === ".json") {
    const dir = path.dirname(trimmed);
    if (existsSync(path.join(dir, "product.json"))) {
      return dir;
    }
  }

  const directProduct = path.join(trimmed, "product.json");
  const directMain = path.join(trimmed, "out", "main.js");
  if (existsSync(directProduct) && existsSync(directMain)) {
    return trimmed;
  }

  const nestedAppRoot = path.join(trimmed, "app");
  if (existsSync(path.join(nestedAppRoot, "product.json")) && existsSync(path.join(nestedAppRoot, "out", "main.js"))) {
    return nestedAppRoot;
  }

  const appRoot = path.join(trimmed, "resources", "app");
  if (existsSync(path.join(appRoot, "product.json")) && existsSync(path.join(appRoot, "out", "main.js"))) {
    return appRoot;
  }

  return null;
}

function parseMainJs(mainJsPath: string): Pick<LocalAppMetadata, "clientId" | "clientSecret" | "gcpTosClientId" | "gcpTosClientSecret"> {
  try {
    const text = readFileSync(mainJsPath, "utf8");
    return {
      clientId: text.match(/tfe\s*=\s*"([^"]+apps\.googleusercontent\.com)"/)?.[1],
      clientSecret: text.match(/rfe\s*=\s*"([^"]+)"/)?.[1],
      gcpTosClientId: text.match(/eke\s*=\s*"([^"]+apps\.googleusercontent\.com)"/)?.[1],
      gcpTosClientSecret: text.match(/tke\s*=\s*"([^"]+)"/)?.[1],
    };
  } catch {
    return {};
  }
}

function readLocalAppMetadata(root: string, source: string): LocalAppMetadata | null {
  try {
    const productPath = path.join(root, "product.json");
    const mainJsPath = path.join(root, "out", "main.js");
    if (!existsSync(productPath)) {
      return null;
    }

    const product = JSON.parse(readFileSync(productPath, "utf8")) as { ideVersion?: string };
    const parsedMain = existsSync(mainJsPath) ? parseMainJs(mainJsPath) : {};

    return {
      source,
      root,
      version: typeof product.ideVersion === "string" ? product.ideVersion : undefined,
      ...parsedMain,
    };
  } catch {
    return null;
  }
}

function discoverLocalMetadata(): LocalAppMetadata | null {
  let best: LocalAppMetadata | null = null;

  for (const candidate of candidateRoots()) {
    const root = normalizeRoot(candidate);
    if (!root) continue;
    const metadata = readLocalAppMetadata(root, candidate);
    if (!metadata) continue;
    if (!best || compareVersions(metadata.version, best.version) > 0) {
      best = metadata;
    }
  }

  return best;
}

/**
 * Initialize Antigravity runtime metadata from the local app when available.
 * Falls back to remote version discovery and finally the current baked-in values.
 */
export async function initAntigravityRuntimeMetadata(): Promise<void> {
  const local = discoverLocalMetadata();
  if (local) {
    setAntigravityOAuthClients({
      clientId: local.clientId,
      clientSecret: local.clientSecret,
      gcpTosClientId: local.gcpTosClientId,
      gcpTosClientSecret: local.gcpTosClientSecret,
    });
    if (local.version) {
      setAntigravityVersion(local.version);
    }
    log.info("runtime-metadata-local", {
      source: local.source,
      root: local.root,
      version: local.version ?? getAntigravityVersion(),
      clientIdChanged: local.clientId ? local.clientId !== getAntigravityClientId(false) : false,
      gcpClientIdChanged: local.gcpTosClientId ? local.gcpTosClientId !== getAntigravityClientId(true) : false,
    });
    return;
  }

  await initAntigravityVersion();
  log.info("runtime-metadata-fallback", {
    version: getAntigravityVersion(),
    clientId: getAntigravityClientId(false),
    gcpTosClientId: getAntigravityClientId(true),
    clientSecret: getAntigravityClientSecret(false) ? "present" : "missing",
    gcpTosClientSecret: getAntigravityClientSecret(true) ? "present" : "missing",
  });
}
