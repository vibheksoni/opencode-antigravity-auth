import { execSync } from "node:child_process";
import * as https from "node:https";
import * as os from "node:os";
import * as path from "node:path";

export interface AntigravityBridgeCredentials {
  csrfToken: string;
  port: number;
  processId: number;
  commandLine: string;
  workspaceId?: string;
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

let cachedCredentials: { value: AntigravityBridgeCredentials; expiresAt: number } | null = null;

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

async function discoverCredentials(directory: string): Promise<AntigravityBridgeCredentials> {
  if (process.platform !== "win32") {
    throw new Error("Antigravity IDE bridge currently supports Windows only.");
  }

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

  throw new Error("Antigravity language server not found. Is Antigravity running?");
}

export async function getAntigravityBridgeCredentials(directory: string): Promise<AntigravityBridgeCredentials> {
  const now = Date.now();
  if (cachedCredentials && cachedCredentials.expiresAt > now) {
    return cachedCredentials.value;
  }

  const value = await discoverCredentials(directory);
  cachedCredentials = {
    value,
    expiresAt: now + PROCESS_CACHE_TTL_MS,
  };
  return value;
}

export function clearAntigravityBridgeCredentialCache(): void {
  cachedCredentials = null;
}

export function getAntigravityBridgeUserAgent(): string {
  const platform = process.platform === "win32" ? "Windows NT 10.0; Win64; x64" : os.platform();
  return `Mozilla/5.0 (${platform}) AppleWebKit/537.36 (KHTML, like Gecko) opencode-antigravity-bridge Safari/537.36`;
}

