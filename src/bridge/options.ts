export interface AntigravityBridgePluginOptions {
  force_headless?: boolean;
  headless?: boolean;
  single_headless?: boolean;
  cleanup_on_exit?: boolean;
  debug?: boolean;
  log_dir?: string;
  app_dir?: string;
  bridge?: {
    force_headless?: boolean;
    headless?: boolean;
    single_headless?: boolean;
    cleanup_on_exit?: boolean;
    debug?: boolean;
    log_dir?: string;
    app_dir?: string;
  };
}

let runtimeOptions: AntigravityBridgePluginOptions = {};

/**
 * Initialize bridge runtime options from tuple plugin config in opencode.json.
 *
 * Params:
 * options: Record<string, unknown> | undefined - Raw plugin options from OpenCode.
 *
 * Returns:
 * void
 */
export function initAntigravityBridgeRuntimeOptions(options: Record<string, unknown> | undefined): void {
  runtimeOptions = isRecord(options) ? (options as AntigravityBridgePluginOptions) : {};
}

/**
 * Read whether the bridge should force headless mode from plugin options.
 *
 * Returns:
 * boolean - True when tuple options request headless-only behavior.
 */
export function getAntigravityBridgeForceHeadless(): boolean {
  if (typeof runtimeOptions.force_headless === "boolean") {
    return runtimeOptions.force_headless;
  }

  if (typeof runtimeOptions.headless === "boolean") {
    return runtimeOptions.headless;
  }

  if (isRecord(runtimeOptions.bridge)) {
    const bridge = runtimeOptions.bridge as NonNullable<AntigravityBridgePluginOptions["bridge"]>;
    if (typeof bridge.force_headless === "boolean") {
      return bridge.force_headless;
    }

    if (typeof bridge.headless === "boolean") {
      return bridge.headless;
    }
  }

  return true;
}

/**
 * Read whether the bridge should keep only one headless language server alive at a time.
 *
 * Returns:
 * boolean - True when singleton headless mode is enabled.
 */
export function getAntigravityBridgeSingleHeadless(): boolean {
  if (typeof runtimeOptions.single_headless === "boolean") {
    return runtimeOptions.single_headless;
  }

  if (isRecord(runtimeOptions.bridge) && typeof runtimeOptions.bridge.single_headless === "boolean") {
    return runtimeOptions.bridge.single_headless;
  }

  return false;
}

/**
 * Read whether the bridge should clean up spawned headless processes on parent exit.
 *
 * Returns:
 * boolean - True when cleanup hooks should be registered.
 */
export function getAntigravityBridgeCleanupOnExit(): boolean {
  if (typeof runtimeOptions.cleanup_on_exit === "boolean") {
    return runtimeOptions.cleanup_on_exit;
  }

  if (isRecord(runtimeOptions.bridge) && typeof runtimeOptions.bridge.cleanup_on_exit === "boolean") {
    return runtimeOptions.bridge.cleanup_on_exit;
  }

  return true;
}

/**
 * Read whether bridge debug logging should write to file.
 *
 * Returns:
 * boolean - True when bridge file logging is enabled.
 */
export function getAntigravityBridgeDebugEnabled(): boolean {
  if (typeof runtimeOptions.debug === "boolean") {
    return runtimeOptions.debug;
  }

  if (isRecord(runtimeOptions.bridge) && typeof runtimeOptions.bridge.debug === "boolean") {
    return runtimeOptions.bridge.debug;
  }

  return false;
}

/**
 * Read the optional bridge debug log directory override.
 *
 * Returns:
 * string | undefined - Custom log directory when configured.
 */
export function getAntigravityBridgeLogDir(): string | undefined {
  if (typeof runtimeOptions.log_dir === "string" && runtimeOptions.log_dir.trim()) {
    return runtimeOptions.log_dir.trim();
  }

  if (isRecord(runtimeOptions.bridge) && typeof runtimeOptions.bridge.log_dir === "string" && runtimeOptions.bridge.log_dir.trim()) {
    return runtimeOptions.bridge.log_dir.trim();
  }

  return undefined;
}

/**
 * Read the optional Antigravity app directory override from tuple plugin options.
 *
 * Returns:
 * string | undefined - Custom app directory when configured.
 */
export function getAntigravityBridgeAppDir(): string | undefined {
  if (typeof runtimeOptions.app_dir === "string" && runtimeOptions.app_dir.trim()) {
    return runtimeOptions.app_dir.trim();
  }

  if (isRecord(runtimeOptions.bridge) && typeof runtimeOptions.bridge.app_dir === "string" && runtimeOptions.bridge.app_dir.trim()) {
    return runtimeOptions.bridge.app_dir.trim();
  }

  return undefined;
}

/**
 * Reset bridge runtime options for tests.
 *
 * Returns:
 * void
 */
export function resetAntigravityBridgeRuntimeOptions(): void {
  runtimeOptions = {};
}

/**
 * Check whether a value is a plain object record.
 *
 * Params:
 * value: unknown - Value to inspect.
 *
 * Returns:
 * boolean - True when value is a non-array object.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
