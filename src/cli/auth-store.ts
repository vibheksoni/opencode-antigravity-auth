import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { xdgData } from "xdg-basedir";

interface OAuthAuthEntry {
  type: "oauth";
  refresh: string;
  access: string;
  expires: number;
}

type AuthStore = Record<string, unknown>;

function getDataDir(): string {
  const override = process.env.OPENCODE_GLOBAL_DATA_DIR?.trim();
  if (override) {
    return override;
  }
  return path.join(xdgData!, "opencode");
}

/**
 * Resolve the OpenCode auth store path.
 *
 * @param none void - No input.
 * @returns string - Absolute path to auth.json.
 */
export function getAuthStorePath(): string {
  return path.join(getDataDir(), "auth.json");
}

async function readAuthStore(): Promise<AuthStore> {
  const authPath = getAuthStorePath();
  try {
    const raw = await readFile(authPath, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") {
      return {};
    }
    return parsed as AuthStore;
  } catch {
    return {};
  }
}

/**
 * Persist the Google OAuth entry into OpenCode's auth store.
 *
 * @param input OAuthAuthEntry - OAuth payload to save under the google provider.
 * @returns Promise<string> - Path written to disk.
 */
export async function writeGoogleOAuthAuth(input: OAuthAuthEntry): Promise<string> {
  const authPath = getAuthStorePath();
  const next = await readAuthStore();
  next.google = input;
  await mkdir(path.dirname(authPath), { recursive: true });
  await writeFile(authPath, JSON.stringify(next, null, 2), { encoding: "utf8", mode: 0o600 });
  return authPath;
}

/**
 * Remove the Google auth entry only when it is an OAuth session.
 *
 * @param none void - No input.
 * @returns Promise<boolean> - True when an OAuth entry was removed.
 */
export async function clearGoogleOAuthAuthIfOauth(): Promise<boolean> {
  const authPath = getAuthStorePath();
  const next = await readAuthStore();
  const current = next.google;
  if (!current || typeof current !== "object" || (current as { type?: string }).type !== "oauth") {
    return false;
  }

  delete next.google;
  await mkdir(path.dirname(authPath), { recursive: true });
  await writeFile(authPath, JSON.stringify(next, null, 2), { encoding: "utf8", mode: 0o600 });
  return true;
}
