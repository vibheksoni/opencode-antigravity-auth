import { execSync, spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import * as https from "node:https";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { AccountManager, calculateBackoffMs, parseRateLimitReason } from "../plugin/accounts";
import {
  getAntigravityClientId,
  getAntigravityClientSecret,
} from "../constants";
import {
  calculateTokenExpiry,
  formatRefreshParts,
  parseRefreshParts,
} from "../plugin/auth";
import { createGoogleOAuth2Client } from "../plugin/google-auth";
import { ensureProjectContext } from "../plugin/project";
import {
  AntigravityTokenRefreshError,
} from "../plugin/token";
import { probeRefreshedAccountAccess } from "../plugin/verification";
import { initAntigravityRuntimeMetadata } from "../plugin/runtime-metadata";
import type { OAuthAuthDetails } from "../plugin/types";
import { logBridgeDebug } from "./debug";
import {
  launchHeadlessAntigravityLanguageServer,
  type HeadlessLanguageServerLaunchOptions,
  type HeadlessOAuthTokenInfo,
  type HeadlessLanguageServerHandle,
} from "./headless";
import { getAntigravityBridgeForceHeadless, getAntigravityBridgeSingleHeadless } from "./options";
import { selectBridgePoolCandidate } from "./pool";

export interface AntigravityBridgeCredentials {
  csrfToken: string;
  port: number;
  processId: number;
  commandLine: string;
  workspaceId?: string;
  accountKey?: string;
}

interface LanguageServerProcessInfo {
  ProcessId: number;
  CommandLine: string;
}

interface CandidateProcess {
  processId: number;
  commandLine: string;
  csrfToken: string;
  workspaceId?: string;
  ports: number[];
}

const PROCESS_NAME = "language_server_windows_x64.exe";
const PROCESS_CACHE_TTL_MS = 2_000;
const ACCOUNT_VALIDATION_TTL_MS = 10 * 60 * 1000;
const SAVE_OAUTH_TOKEN_INFO_PATH = "/exa.language_server_pb.LanguageServerService/SaveOAuthTokenInfo";
const HEADLESS_REGISTRY_FILENAME = "antigravity-bridge-headless-pids.json";

interface BridgeCredentialOptions {
  accountKey?: string;
  excludedAccountKeys?: string[];
}

interface PreparedHeadlessLaunch {
  accountKey: string;
  options: HeadlessLanguageServerLaunchOptions;
  oauthTokenInfo?: HeadlessOAuthTokenInfo;
}

let runningCredentialsCache: { value: AntigravityBridgeCredentials; expiresAt: number } | null = null;
const headlessHandles = new Map<string, HeadlessLanguageServerHandle>();
const headlessLaunchPromises = new Map<string, Promise<HeadlessLanguageServerHandle>>();
const validatedHeadlessAccounts = new Map<string, number>();
let headlessAccountCursor = 0;

function readJsonCommand<T>(command: string): T | null {
  try {
    const output = execSync(command, {
      encoding: "utf8",
      timeout: 10_000,
      windowsHide: true,
    }).trim();
    if (!output) {
      return null;
    }
    return JSON.parse(output) as T;
  } catch {
    return null;
  }
}

function toArray<T>(value: T | T[] | null | undefined): T[] {
  if (value == null) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

function getWindowsLanguageServerProcesses(): LanguageServerProcessInfo[] {
  const command = `powershell -NoProfile -Command "$procs = Get-CimInstance Win32_Process | Where-Object { $_.Name -eq '${PROCESS_NAME}' -and $_.CommandLine -match 'app_data_dir antigravity' } | Select-Object ProcessId, CommandLine; if ($procs) { $procs | ConvertTo-Json -Compress }"`;
  return toArray(readJsonCommand<LanguageServerProcessInfo | LanguageServerProcessInfo[]>(command));
}

function shouldForceHeadless(): boolean {
  return getAntigravityBridgeForceHeadless() || process.env.OPENCODE_ANTIGRAVITY_BRIDGE_FORCE_HEADLESS?.trim() === "1";
}

function getBridgeRegistryPath(): string {
  const configDir = process.env.OPENCODE_CONFIG_DIR?.trim() || path.join(os.homedir(), ".config", "opencode");
  return path.join(configDir, HEADLESS_REGISTRY_FILENAME);
}

async function readTrackedHeadlessPids(): Promise<number[]> {
  try {
    const raw = await readFile(getBridgeRegistryPath(), "utf8");
    const parsed = JSON.parse(raw) as { pids?: number[] } | number[];
    const list = Array.isArray(parsed) ? parsed : parsed?.pids;
    return Array.isArray(list) ? list.filter((value): value is number => Number.isInteger(value) && value > 0) : [];
  } catch {
    return [];
  }
}

async function writeTrackedHeadlessPids(pids: number[]): Promise<void> {
  const registryPath = getBridgeRegistryPath();
  await mkdir(path.dirname(registryPath), { recursive: true });
  await writeFile(registryPath, JSON.stringify({ pids }, null, 2), "utf8");
}

function killProcessTree(pid: number): void {
  if (!Number.isInteger(pid) || pid <= 0) {
    return;
  }

  if (process.platform === "win32") {
    spawnSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
    return;
  }

  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // ignore failures for already-dead processes
  }
}

async function cleanupTrackedHeadlessProcesses(keepPid?: number): Promise<void> {
  const tracked = await readTrackedHeadlessPids();
  const survivors: number[] = [];

  for (const pid of tracked) {
    if (keepPid && pid === keepPid) {
      survivors.push(pid);
      continue;
    }

    killProcessTree(pid);
  }

  await writeTrackedHeadlessPids(survivors);
}

async function registerTrackedHeadlessProcess(pid: number): Promise<void> {
  const tracked = await readTrackedHeadlessPids();
  const next = [...new Set([...tracked.filter((value) => value !== pid), pid])];
  await writeTrackedHeadlessPids(next);
}

async function unregisterTrackedHeadlessProcess(pid: number): Promise<void> {
  const tracked = await readTrackedHeadlessPids();
  await writeTrackedHeadlessPids(tracked.filter((value) => value !== pid));
}

function getAccountLabel(account: { email?: string; index: number }): string {
  return account.email?.trim() || `Account ${account.index + 1}`;
}

function getValidatedHeadlessAccount(auth: OAuthAuthDetails): OAuthAuthDetails | null {
  const key = parseRefreshParts(auth.refresh).refreshToken;
  if (!key) {
    return null;
  }

  const expiresAt = validatedHeadlessAccounts.get(key) ?? 0;
  return expiresAt > Date.now() ? auth : null;
}

function markValidatedHeadlessAccount(auth: OAuthAuthDetails): void {
  const key = parseRefreshParts(auth.refresh).refreshToken;
  if (!key) {
    return;
  }

  validatedHeadlessAccounts.set(key, Date.now() + ACCOUNT_VALIDATION_TTL_MS);
}

function clearValidatedHeadlessAccount(refresh: string): void {
  const key = parseRefreshParts(refresh).refreshToken;
  if (!key) {
    return;
  }

  validatedHeadlessAccounts.delete(key);
}

function isOAuthClientInteropError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("google-auth-library did not expose OAuth2Client");
}

function resolveSubprocessModuleURL(sourceRelative: string, distRelative: string): string {
  const current = new URL(import.meta.url);
  return current.pathname.includes("/dist/")
    ? new URL(distRelative, import.meta.url).href
    : new URL(sourceRelative, import.meta.url).href;
}

function refreshBridgeAccessTokenViaSubprocess(
  auth: OAuthAuthDetails,
  accountLabel: string,
  accountIndex: number,
  clientId: string,
  clientSecret: string,
): OAuthAuthDetails & { access: string } {
  const helperPath = fileURLToPath(resolveSubprocessModuleURL("../plugin/google-auth.ts", "../plugin/google-auth.js"));
  const authPath = fileURLToPath(resolveSubprocessModuleURL("../plugin/auth.ts", "../plugin/auth.js"));
  const script = [
    `const payload = JSON.parse(await Bun.stdin.text());`,
    `const { pathToFileURL } = await import("node:url");`,
    `const { createGoogleOAuth2Client } = await import(pathToFileURL(payload.helperPath).href);`,
    `const { parseRefreshParts, formatRefreshParts, calculateTokenExpiry } = await import(pathToFileURL(payload.authPath).href);`,
    `const parts = parseRefreshParts(payload.auth.refresh);`,
    `const oauth = await createGoogleOAuth2Client(payload.clientId, payload.clientSecret);`,
    `oauth.setCredentials({ refresh_token: parts.refreshToken });`,
    `const startedAt = Date.now();`,
    `const refreshed = await oauth.refreshAccessToken();`,
    `const credentials = refreshed.credentials;`,
    `if (!credentials.access_token) throw new Error("No access token returned from subprocess refresh.");`,
    `const result = {`,
    `  ...payload.auth,`,
    `  access: credentials.access_token,`,
    `  expires: typeof credentials.expiry_date === "number" ? credentials.expiry_date : calculateTokenExpiry(startedAt, credentials.expires_in),`,
    `  refresh: formatRefreshParts({`,
    `    refreshToken: credentials.refresh_token ?? parts.refreshToken,`,
    `    projectId: parts.projectId,`,
    `    managedProjectId: parts.managedProjectId,`,
    `    isGcpTos: parts.isGcpTos,`,
    `  }),`,
    `};`,
    `console.log(JSON.stringify(result));`,
  ].join("\n");

  const child = spawnSync(process.execPath, ["-e", script], {
    input: JSON.stringify({ auth, helperPath, authPath, clientId, clientSecret }),
    encoding: "utf8",
    windowsHide: true,
    env: process.env,
  });

  if (child.status !== 0) {
    logBridgeDebug("bridge-account-refresh-subprocess-error", {
      account: accountLabel,
      index: accountIndex,
      status: child.status,
      stderr: child.stderr?.trim().slice(0, 800),
    });
    throw new Error(child.stderr?.trim() || `Subprocess refresh failed for ${accountLabel}.`);
  }

  const output = child.stdout?.trim();
  if (!output) {
    throw new Error(`Subprocess refresh returned empty output for ${accountLabel}.`);
  }

  logBridgeDebug("bridge-account-refresh-subprocess-ok", {
    account: accountLabel,
    index: accountIndex,
  });
  return JSON.parse(output) as OAuthAuthDetails & { access: string };
}

async function refreshBridgeAccessToken(
  auth: OAuthAuthDetails,
  accountLabel: string,
  accountIndex: number,
): Promise<OAuthAuthDetails & { access: string }> {
  const parts = parseRefreshParts(auth.refresh);
  if (!parts.refreshToken) {
    throw new Error(`Missing refresh token for ${accountLabel}.`);
  }

  const clientId = getAntigravityClientId(parts.isGcpTos);
  const clientSecret = getAntigravityClientSecret(parts.isGcpTos);
  if (!clientId || !clientSecret) {
    throw new AntigravityTokenRefreshError({
      message: "Antigravity OAuth client metadata is unavailable.",
      status: 0,
      statusText: "Missing OAuth client metadata",
    });
  }

  const requestedAt = Date.now();

  try {
    const oauth = await createGoogleOAuth2Client(clientId, clientSecret);
    oauth.setCredentials({
      refresh_token: parts.refreshToken,
    });
    const refreshed = await oauth.refreshAccessToken();
    const credentials = refreshed.credentials as {
      access_token?: string | null;
      expiry_date?: number | null;
      refresh_token?: string | null;
      token_type?: string | null;
      expires_in?: number | null;
    };
    if (!credentials.access_token) {
      logBridgeDebug("bridge-account-refresh-empty", {
        account: accountLabel,
        index: accountIndex,
        hasRefreshToken: !!credentials.refresh_token,
        tokenType: credentials.token_type ?? null,
        expiresIn: credentials.expires_in ?? null,
      });
      throw new Error(`No access token available for ${accountLabel}.`);
    }

    return {
      ...auth,
      access: credentials.access_token,
      expires:
        typeof credentials.expiry_date === "number"
          ? credentials.expiry_date
          : calculateTokenExpiry(requestedAt, credentials.expires_in),
      refresh: formatRefreshParts({
        refreshToken: credentials.refresh_token ?? parts.refreshToken,
        projectId: parts.projectId,
        managedProjectId: parts.managedProjectId,
        isGcpTos: parts.isGcpTos,
      }),
    };
  } catch (error) {
    const response = (error as { response?: { status?: number; statusText?: string; data?: unknown } }).response;
    const status = response?.status ?? 0;
    const statusText = response?.statusText ?? "Token refresh failed";
    const responseText = (() => {
      if (typeof response?.data === "string") {
        return response.data;
      }
      if (response?.data === undefined) {
        return undefined;
      }
      try {
        return JSON.stringify(response.data);
      } catch {
        return String(response.data);
      }
    })();
    const code = responseText?.match(/invalid_grant|invalid_request|unauthorized_client/i)?.[0]?.toLowerCase();

    logBridgeDebug("bridge-account-refresh-error", {
      account: accountLabel,
      index: accountIndex,
      status,
      statusText,
      code,
      response: responseText?.slice(0, 800),
      error: error instanceof Error ? error.message : String(error),
    });

    if (isOAuthClientInteropError(error)) {
      return refreshBridgeAccessTokenViaSubprocess(auth, accountLabel, accountIndex, clientId, clientSecret);
    }

    if (error instanceof AntigravityTokenRefreshError) {
      throw error;
    }

    if (code) {
      throw new AntigravityTokenRefreshError({
        message: `${accountLabel} token refresh failed (${status} ${statusText})`,
        code,
        description: responseText,
        status,
        statusText,
      });
    }

    throw error;
  }
}

async function refreshAndValidateHeadlessAccount(
  manager: AccountManager,
  account: ReturnType<AccountManager["getAccounts"]>[number],
): Promise<OAuthAuthDetails & { access: string }> {
  const label = getAccountLabel(account);
  let auth = manager.toAuthDetails(account);
  const cached = getValidatedHeadlessAccount(auth);
  if (cached?.access) {
    logBridgeDebug("bridge-account-validation-cache-hit", {
      account: label,
      index: account.index,
    });
    return cached as OAuthAuthDetails & { access: string };
  }

  try {
    const refreshed = await refreshBridgeAccessToken(auth, label, account.index);
    auth = refreshed;
    manager.updateFromAuth(account, refreshed);
    await manager.saveToDisk();
  } catch (error) {
    clearValidatedHeadlessAccount(auth.refresh);

    if (error instanceof AntigravityTokenRefreshError && error.code === "invalid_grant") {
      const removed = manager.removeAccount(account);
      if (removed) {
        await manager.saveToDisk();
      }

      logBridgeDebug("bridge-account-invalid-grant", {
        account: label,
        index: account.index,
        removed,
      });
    }

    throw error;
  }

  const verification = await probeRefreshedAccountAccess(auth);
  if (verification.status === "blocked") {
    manager.markAccountVerificationRequired(account.index, verification.message, verification.verifyUrl);
    await manager.saveToDisk();
    clearValidatedHeadlessAccount(auth.refresh);

    logBridgeDebug("bridge-account-verification-required", {
      account: label,
      index: account.index,
      verifyUrl: verification.verifyUrl,
      message: verification.message,
    });

    throw new Error(`${label} requires Google verification.`);
  }

  if (verification.status === "error") {
    clearValidatedHeadlessAccount(auth.refresh);
    logBridgeDebug("bridge-account-validation-error", {
      account: label,
      index: account.index,
      message: verification.message,
    });
    throw new Error(`Preflight validation failed for ${label}: ${verification.message}`);
  }

  const projectContext = await ensureProjectContext(auth);
  auth = projectContext.auth;
  manager.updateFromAuth(account, auth);
  await manager.saveToDisk();
  markValidatedHeadlessAccount(auth);
  logBridgeDebug("bridge-account-validation-ok", {
    account: label,
    index: account.index,
    projectId: projectContext.effectiveProjectId,
  });
  return auth as OAuthAuthDetails & { access: string };
}

function getListeningPortsForProcess(pid: number): number[] {
  const command = `powershell -NoProfile -Command "$ports = Get-NetTCPConnection -OwningProcess ${pid} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty LocalPort -Unique; if ($ports) { $ports | ConvertTo-Json -Compress }"`;
  const parsed = readJsonCommand<number | number[]>(command);
  return toArray(parsed)
    .map((value) => Number(value))
    .filter((value) => Number.isInteger(value) && value > 0)
    .sort((left, right) => left - right);
}

function parseCommandLineValue(commandLine: string, flag: string): string | undefined {
  const match = commandLine.match(new RegExp(`${flag}\\s+(\"[^\"]+\"|\\S+)`, "i"));
  if (!match?.[1]) {
    return undefined;
  }
  return match[1].replace(/^"|"$/g, "");
}

function pathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9]/g, "_");
}

function workspaceIdForDirectory(directory: string): string {
  const resolved = path.resolve(directory);
  const normalized = resolved.replace(/\//g, "\\");
  const driveMatch = normalized.match(/^([A-Za-z]):\\(.*)$/);
  if (driveMatch) {
    const drive = driveMatch[1]!.toLowerCase();
    const remainder = driveMatch[2]!.split("\\").filter(Boolean).map(pathSegment).join("_");
    return `file_${drive}_3A_${remainder}`;
  }
  return `file_${pathSegment(normalized.replace(/\\/g, "_"))}`;
}

function scoreCandidate(directory: string, candidate: CandidateProcess): number {
  const wantedWorkspaceId = workspaceIdForDirectory(directory);
  if (candidate.workspaceId && candidate.workspaceId === wantedWorkspaceId) {
    return 0;
  }
  if (!candidate.workspaceId) {
    return 1;
  }
  return 2;
}

function probeLocalConnectPort(port: number, csrfToken: string): Promise<boolean> {
  return new Promise((resolve) => {
    const request = https.request(
      {
        host: "127.0.0.1",
        port,
        path: "/exa.language_server_pb.LanguageServerService/ListPages",
        method: "POST",
        rejectUnauthorized: false,
        timeout: 4_000,
        headers: {
          "connect-protocol-version": "1",
          "content-type": "application/json",
          "x-codeium-csrf-token": csrfToken,
        },
      },
      (response) => {
        response.resume();
        resolve(response.statusCode === 200);
      },
    );

    request.on("timeout", () => {
      request.destroy();
      resolve(false);
    });
    request.on("error", () => resolve(false));
    request.end("{}");
  });
}

async function discoverRunningIdeCredentials(directory: string): Promise<AntigravityBridgeCredentials | null> {
  const candidates = getWindowsLanguageServerProcesses()
    .map((processInfo): CandidateProcess | null => {
      const csrfToken = parseCommandLineValue(processInfo.CommandLine, "--csrf_token");
      if (!csrfToken) {
        return null;
      }
      return {
        processId: processInfo.ProcessId,
        commandLine: processInfo.CommandLine,
        csrfToken,
        workspaceId: parseCommandLineValue(processInfo.CommandLine, "--workspace_id"),
        ports: getListeningPortsForProcess(processInfo.ProcessId),
      };
    })
    .filter((candidate): candidate is CandidateProcess => candidate !== null)
    .sort((left, right) => {
      const scoreDelta = scoreCandidate(directory, left) - scoreCandidate(directory, right);
      if (scoreDelta !== 0) {
        return scoreDelta;
      }
      return left.processId - right.processId;
    });

  for (const candidate of candidates) {
    for (const port of candidate.ports) {
      if (await probeLocalConnectPort(port, candidate.csrfToken)) {
        return {
          csrfToken: candidate.csrfToken,
          port,
          processId: candidate.processId,
          commandLine: candidate.commandLine,
          workspaceId: candidate.workspaceId,
        };
      }
    }
  }

  return null;
}

async function discoverCredentials(directory: string, options: BridgeCredentialOptions = {}): Promise<AntigravityBridgeCredentials> {
  if (process.platform !== "win32") {
    throw new Error("Antigravity IDE bridge currently supports Windows only.");
  }

  logBridgeDebug("bridge-discover-credentials", {
    directory,
    forceHeadless: shouldForceHeadless(),
    preferredAccount: options.accountKey?.slice(-8),
    excludedAccounts: (options.excludedAccountKeys ?? []).map((value) => value.slice(-8)),
  });

  if (!shouldForceHeadless()) {
    try {
      const { accountKey, handle } = await getOrStartHeadlessHandle(options.accountKey, options.excludedAccountKeys);
      return {
        csrfToken: handle.csrfToken,
        port: handle.port,
        processId: handle.processId,
        commandLine: handle.commandLine,
        accountKey,
      };
    } catch (error) {
      if (options.accountKey || (options.excludedAccountKeys?.length ?? 0) > 0) {
        throw error;
      }
      const running = await discoverRunningIdeCredentials(directory);
      if (running) {
        return running;
      }
      throw error;
    }
  }

  const { accountKey, handle } = await getOrStartHeadlessHandle(options.accountKey, options.excludedAccountKeys);
  return {
    csrfToken: handle.csrfToken,
    port: handle.port,
    processId: handle.processId,
    commandLine: handle.commandLine,
    accountKey,
  };
}

async function getOrStartHeadlessHandle(
  preferredAccountKey?: string,
  excludedAccountKeys: string[] = [],
): Promise<{ accountKey: string; handle: HeadlessLanguageServerHandle }> {
  const prepared = await buildHeadlessLaunchOptions(preferredAccountKey, excludedAccountKeys);
  const existing = headlessHandles.get(prepared.accountKey);
  if (existing?.isAlive()) {
    logBridgeDebug("bridge-headless-reuse", {
      accountKey: prepared.accountKey.slice(-8),
      processId: existing.processId,
      port: existing.port,
    });
    if (getAntigravityBridgeSingleHeadless()) {
      await disposeOtherHeadlessHandles(prepared.accountKey);
    }
    return {
      accountKey: prepared.accountKey,
      handle: existing,
    };
  }
  if (existing) {
    headlessHandles.delete(prepared.accountKey);
  }

  const inFlight = headlessLaunchPromises.get(prepared.accountKey);
  if (inFlight) {
    return {
      accountKey: prepared.accountKey,
      handle: await inFlight,
    };
  }

  const launchPromise = launchHeadlessAntigravityLanguageServer(prepared.options)
      .then(async (handle) => {
        logBridgeDebug("bridge-headless-started", {
          accountKey: prepared.accountKey.slice(-8),
          processId: handle.processId,
          port: handle.port,
        });
        if (getAntigravityBridgeSingleHeadless()) {
          await disposeOtherHeadlessHandles(prepared.accountKey);
        }
        await injectHeadlessOauthTokenInfo(handle, prepared.oauthTokenInfo);
        await registerTrackedHeadlessProcess(handle.processId);
        headlessHandles.set(prepared.accountKey, handle);
        return handle;
      })
      .finally(() => {
        headlessLaunchPromises.delete(prepared.accountKey);
      });

  headlessLaunchPromises.set(prepared.accountKey, launchPromise);

  return {
    accountKey: prepared.accountKey,
    handle: await launchPromise,
  };
}

async function disposeOtherHeadlessHandles(keepAccountKey: string): Promise<void> {
  const otherEntries = [...headlessHandles.entries()].filter(([accountKey]) => accountKey !== keepAccountKey);
  for (const [accountKey, handle] of otherEntries) {
    headlessHandles.delete(accountKey);
    headlessLaunchPromises.delete(accountKey);
    await handle.dispose();
    await unregisterTrackedHeadlessProcess(handle.processId);
  }
}

async function buildHeadlessLaunchOptions(
  preferredAccountKey?: string,
  excludedAccountKeys: string[] = [],
): Promise<PreparedHeadlessLaunch> {
  await initAntigravityRuntimeMetadata();
  const manager = await AccountManager.loadFromDisk();
  const accounts = manager.getEnabledAccounts().filter((account) => !manager.isAccountCoolingDown(account));
  const tried = new Set(excludedAccountKeys);
  let lastError: unknown;
  let nextCursor = headlessAccountCursor;

  while (tried.size < accounts.length) {
    const selection = selectBridgePoolCandidate(
      accounts.map((account) => ({ key: account.parts.refreshToken })),
      nextCursor,
      preferredAccountKey,
      [...tried],
    );

    if (!selection.selectedKey) {
      break;
    }

    nextCursor = selection.nextCursor;
    tried.add(selection.selectedKey);

    const account = accounts.find((candidate) => candidate.parts.refreshToken === selection.selectedKey) ?? null;
    if (!account) {
      continue;
    }

    try {
      const auth = await refreshAndValidateHeadlessAccount(manager, account);

      const refreshParts = parseRefreshParts(auth.refresh);
      const oauthTokenInfo: HeadlessOAuthTokenInfo = {
        accessToken: auth.access,
        refreshToken: refreshParts.refreshToken,
        tokenType: "Bearer",
        expiryDateSeconds: Math.floor((auth.expires ?? Date.now()) / 1000),
        isGcpTos: refreshParts.isGcpTos === true,
      };

      headlessAccountCursor = nextCursor;
      logBridgeDebug("bridge-account-selected", {
        account: getAccountLabel(account),
        index: account.index,
        key: selection.selectedKey.slice(-8),
      });
      return {
        accountKey: selection.selectedKey,
        oauthTokenInfo,
        options: {
          accessToken: auth.access,
          oauthTokenInfo,
        },
      };
    } catch (error) {
      lastError = error;
      logBridgeDebug("bridge-account-selection-failed", {
        account: getAccountLabel(account),
        index: account.index,
        key: selection.selectedKey.slice(-8),
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (lastError) {
    throw lastError;
  }

  throw new Error("No enabled Antigravity accounts available for headless bridge.");
}

function postHeadlessLanguageServerJson(
  handle: HeadlessLanguageServerHandle,
  path: string,
  body: unknown,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = https.request(
      {
        host: "127.0.0.1",
        port: handle.port,
        path,
        method: "POST",
        rejectUnauthorized: false,
        headers: {
          "connect-protocol-version": "1",
          "content-type": "application/json",
          "x-codeium-csrf-token": handle.csrfToken,
          "user-agent": getAntigravityBridgeUserAgent(),
        },
      },
      (response) => {
        let data = "";
        response.on("data", (chunk) => {
          data += chunk.toString();
        });
        response.on("end", () => {
          resolve({
            status: response.statusCode ?? 0,
            body: data,
          });
        });
      },
    );

    request.on("error", reject);
    request.write(JSON.stringify(body));
    request.end();
  });
}

async function injectHeadlessOauthTokenInfo(
  handle: HeadlessLanguageServerHandle,
  oauthTokenInfo?: HeadlessOAuthTokenInfo,
): Promise<void> {
  if (!oauthTokenInfo) {
    return;
  }
  const response = await postHeadlessLanguageServerJson(handle, SAVE_OAUTH_TOKEN_INFO_PATH, {
    tokenInfo: {
      accessToken: oauthTokenInfo.accessToken,
      refreshToken: oauthTokenInfo.refreshToken,
      tokenType: oauthTokenInfo.tokenType,
      expiry: {
        seconds: BigInt(Math.floor(oauthTokenInfo.expiryDateSeconds)).toString(),
      },
      isGcpTos: oauthTokenInfo.isGcpTos,
    },
  });

  if (response.status !== 200 && response.status !== 404) {
    throw new Error(`Failed to inject OAuth token into headless Antigravity LS (HTTP ${response.status}): ${response.body}`);
  }
}

export async function getAntigravityBridgeCredentials(
  directory: string,
  options: BridgeCredentialOptions = {},
): Promise<AntigravityBridgeCredentials> {
  const now = Date.now();
  if (!shouldForceHeadless() && !options.accountKey && runningCredentialsCache && runningCredentialsCache.expiresAt > now) {
    return runningCredentialsCache.value;
  }

  const value = await discoverCredentials(directory, options);
  if (!shouldForceHeadless() && !options.accountKey && !value.accountKey) {
    runningCredentialsCache = {
      value,
      expiresAt: now + PROCESS_CACHE_TTL_MS,
    };
  }
  return value;
}

export function clearAntigravityBridgeCredentialCache(): void {
  runningCredentialsCache = null;
}

export async function markHeadlessBridgeAccountFailure(accountKey: string, message: string): Promise<void> {
  const manager = await AccountManager.loadFromDisk();
  const account = manager.getAccounts().find((candidate) => candidate.parts.refreshToken === accountKey);
  if (!account) {
    return;
  }

  const reason = parseRateLimitReason(undefined, message, undefined);
  const cooldownMs = calculateBackoffMs(reason, account.consecutiveFailures ?? 0);
  account.consecutiveFailures = (account.consecutiveFailures ?? 0) + 1;
  manager.markAccountCoolingDown(account, cooldownMs, "project-error");
  manager.requestSaveToDisk();
  await manager.flushSaveToDisk();
}

export async function shutdownAntigravityBridgeHeadlessServer(): Promise<void> {
  runningCredentialsCache = null;
  validatedHeadlessAccounts.clear();
  const handles = [...headlessHandles.values()];
  headlessHandles.clear();
  headlessLaunchPromises.clear();
  for (const handle of handles) {
    await handle.dispose();
    await unregisterTrackedHeadlessProcess(handle.processId);
  }
}

export async function evictHeadlessBridgeAccount(accountKey: string): Promise<void> {
  const handle = headlessHandles.get(accountKey);
  headlessHandles.delete(accountKey);
  headlessLaunchPromises.delete(accountKey);
  validatedHeadlessAccounts.delete(accountKey);
  if (handle) {
    await handle.dispose();
    await unregisterTrackedHeadlessProcess(handle.processId);
  }
}

export function getAntigravityBridgeUserAgent(): string {
  const platform = process.platform === "win32" ? "Windows NT 10.0; Win64; x64" : os.platform();
  return `Mozilla/5.0 (${platform}) AppleWebKit/537.36 (KHTML, like Gecko) opencode-antigravity-bridge Safari/537.36`;
}
