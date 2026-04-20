import { appendFileSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

import {
  getAntigravityBridgeDebugEnabled,
  getAntigravityBridgeLogDir,
} from "./options";

const DEBUG_ENV_FLAG = "OPENCODE_ANTIGRAVITY_BRIDGE_DEBUG";
const DEFAULT_MAX_LOG_FILES = 25;
const LOG_FILE_PREFIX = "antigravity-bridge-debug-";

let bridgeLogFilePath: string | null = null;

/**
 * Write a bridge debug entry to the configured log file.
 *
 * Params:
 * message: string - Primary debug message.
 * extra: Record<string, unknown> | undefined - Optional structured metadata.
 *
 * Returns:
 * void
 */
export function logBridgeDebug(message: string, extra?: Record<string, unknown>): void {
  if (!isBridgeDebugEnabled()) {
    return;
  }

  const logPath = getBridgeLogFilePath();
  if (!logPath) {
    return;
  }

  const timestamp = new Date().toISOString();
  const suffix = extra && Object.keys(extra).length > 0 ? ` ${safeJson(extra)}` : "";

  try {
    appendFileSync(logPath, `[${timestamp}] ${message}${suffix}\n`, "utf8");
  } catch {
    // ignore file logging failures
  }
}

/**
 * Return the current bridge debug log file path when logging is enabled.
 *
 * Returns:
 * string | undefined - Active bridge log file path.
 */
export function getBridgeDebugLogFilePath(): string | undefined {
  const value = getBridgeLogFilePath();
  return value ?? undefined;
}

/**
 * Reset bridge debug state for tests.
 *
 * Returns:
 * void
 */
export function resetBridgeDebugState(): void {
  bridgeLogFilePath = null;
}

function isBridgeDebugEnabled(): boolean {
  return getAntigravityBridgeDebugEnabled() || isTruthyFlag(process.env[DEBUG_ENV_FLAG]);
}

function getBridgeLogFilePath(): string | null {
  if (!isBridgeDebugEnabled()) {
    return null;
  }

  if (bridgeLogFilePath) {
    return bridgeLogFilePath;
  }

  const logsDir = getBridgeLogsDir();
  if (!logsDir) {
    return null;
  }

  cleanupOldBridgeLogs(logsDir);
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  bridgeLogFilePath = join(logsDir, `${LOG_FILE_PREFIX}${timestamp}.log`);
  return bridgeLogFilePath;
}

function getBridgeLogsDir(): string | null {
  const configured = getAntigravityBridgeLogDir();
  const configDir = process.env.OPENCODE_CONFIG_DIR?.trim() || join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "opencode");
  const logsDir = configured || join(configDir, "antigravity-logs");

  try {
    mkdirSync(logsDir, { recursive: true });
    return logsDir;
  } catch {
    return null;
  }
}

function cleanupOldBridgeLogs(logsDir: string): void {
  try {
    const files = readdirSync(logsDir)
      .filter((file) => file.startsWith(LOG_FILE_PREFIX) && file.endsWith(".log"))
      .map((file) => ({
        path: join(logsDir, file),
        mtimeMs: statSync(join(logsDir, file)).mtimeMs,
      }))
      .sort((left, right) => right.mtimeMs - left.mtimeMs);

    for (const file of files.slice(DEFAULT_MAX_LOG_FILES - 1)) {
      unlinkSync(file.path);
    }
  } catch {
    // ignore cleanup failures
  }
}

function safeJson(value: Record<string, unknown>): string {
  try {
    return JSON.stringify(value);
  } catch {
    return "{\"serialization\":\"failed\"}";
  }
}

function isTruthyFlag(value: string | undefined): boolean {
  if (!value) {
    return false;
  }

  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}
