import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as crypto from "node:crypto";
import { existsSync } from "node:fs";
import * as http from "node:http";
import * as https from "node:https";
import * as os from "node:os";
import * as path from "node:path";

import { getAntigravityIDEMetadata, getAntigravityUserAgent } from "../constants";
import { resolveCloudCodeBaseUrl } from "../plugin/cloud-code";
import { findLocalAntigravityAppRoot, initAntigravityRuntimeMetadata } from "../plugin/runtime-metadata";

export interface HeadlessLanguageServerStarted {
  httpsPort: number;
  httpPort: number;
  lspPort: number;
}

export interface HeadlessLanguageServerHandle {
  appRoot: string;
  binaryPath: string;
  commandLine: string;
  csrfToken: string;
  process: ChildProcessWithoutNullStreams;
  port: number;
  processId: number;
  workspaceId?: string;
  dispose(): Promise<void>;
  isAlive(): boolean;
}

export interface HeadlessLanguageServerLaunchOptions {
  accessToken?: string;
  disableTelemetry?: boolean;
  userTierId?: string;
  oauthTokenInfo?: HeadlessOAuthTokenInfo;
}

export interface HeadlessOAuthTokenInfo {
  accessToken: string;
  refreshToken: string;
  tokenType: string;
  expiryDateSeconds: number;
  isGcpTos: boolean;
}

const EXTENSION_SERVER_SERVICE_PREFIX = "/exa.extension_server_pb.ExtensionServerService";
const LANGUAGE_SERVER_STARTED_PATH = `${EXTENSION_SERVER_SERVICE_PREFIX}/LanguageServerStarted`;
const HEARTBEAT_PATH = `${EXTENSION_SERVER_SERVICE_PREFIX}/Heartbeat`;
const SUBSCRIBE_TO_UNIFIED_STATE_SYNC_TOPIC_PATH = `${EXTENSION_SERVER_SERVICE_PREFIX}/SubscribeToUnifiedStateSyncTopic`;
const PUSH_UNIFIED_STATE_SYNC_UPDATE_PATH = `${EXTENSION_SERVER_SERVICE_PREFIX}/PushUnifiedStateSyncUpdate`;
const LANGUAGE_SERVER_SERVICE_PREFIX = "/exa.language_server_pb.LanguageServerService";
const LANGUAGE_SERVER_HEARTBEAT_PATH = `${LANGUAGE_SERVER_SERVICE_PREFIX}/Heartbeat`;
const HEARTBEAT_INTERVAL_MS = 15_000;
const OAUTH_TOPIC_NAME = "uss-oauth";
const OAUTH_TOPIC_KEY = "oauthTokenInfoSentinelKey";

function isHeadlessDebugEnabled(): boolean {
  return process.env.OPENCODE_ANTIGRAVITY_BRIDGE_DEBUG_HEADLESS?.trim() === "1";
}

function getLanguageServerBinaryName(platform: string = process.platform, arch: string = process.arch): string | undefined {
  if (platform === "linux") {
    if (arch === "arm64") return "language_server_linux_arm";
    if (arch === "x64") return "language_server_linux_x64";
  }

  if (platform === "darwin") {
    if (arch === "arm64") return "language_server_macos_arm";
    if (arch === "x64") return "language_server_macos_x64";
  }

  if (platform === "win32") {
    if (arch === "arm64") return "language_server_windows_arm.exe";
    if (arch === "x64") return "language_server_windows_x64.exe";
  }

  return undefined;
}

function getLanguageServerBinaryPath(appRoot: string): string {
  const override = process.env.CODEIUM_LANGUAGE_SERVER_BIN?.trim();
  if (override && existsSync(override)) {
    return override;
  }

  const binaryName = getLanguageServerBinaryName();
  if (!binaryName) {
    throw new Error(`Unsupported Antigravity language server platform ${process.platform}/${process.arch}.`);
  }

  const binaryPath = path.join(appRoot, "extensions", "antigravity", "bin", binaryName);
  if (!existsSync(binaryPath)) {
    throw new Error(`Antigravity language server binary not found at ${binaryPath}.`);
  }

  return binaryPath;
}

function encodeVarint(value: number): Buffer {
  const bytes: number[] = [];
  let current = value >>> 0;
  while (current >= 0x80) {
    bytes.push((current & 0x7f) | 0x80);
    current >>>= 7;
  }
  bytes.push(current);
  return Buffer.from(bytes);
}

function encodeFieldKey(fieldNumber: number, wireType: number): Buffer {
  return encodeVarint((fieldNumber << 3) | wireType);
}

function encodeStringField(fieldNumber: number, value: string): Buffer {
  const payload = Buffer.from(value, "utf8");
  return Buffer.concat([encodeFieldKey(fieldNumber, 2), encodeVarint(payload.length), payload]);
}

function encodeBoolField(fieldNumber: number, value: boolean): Buffer {
  return Buffer.concat([encodeFieldKey(fieldNumber, 0), Buffer.from([value ? 1 : 0])]);
}

function encodeMessageField(fieldNumber: number, payload: Buffer): Buffer {
  return Buffer.concat([encodeFieldKey(fieldNumber, 2), encodeVarint(payload.length), payload]);
}

function readVarint(buffer: Buffer, startOffset: number): { value: number; offset: number } {
  let value = 0;
  let shift = 0;
  let offset = startOffset;

  while (offset < buffer.length) {
    const byte = buffer[offset]!;
    value |= (byte & 0x7f) << shift;
    offset += 1;
    if ((byte & 0x80) === 0) {
      return { value, offset };
    }
    shift += 7;
  }

  throw new Error("Invalid protobuf varint.");
}

function unwrapConnectStreamingRequest(body: Buffer): Buffer {
  if (body.length < 5) {
    return body;
  }

  const length = body.readUInt32BE(1);
  if (length + 5 > body.length) {
    return body;
  }

  return body.subarray(5, 5 + length);
}

function encodeConnectStreamFrame(flags: number, payload: Buffer): Buffer {
  const frame = Buffer.alloc(5 + payload.length);
  frame[0] = flags;
  frame.writeUInt32BE(payload.length, 1);
  payload.copy(frame, 5);
  return frame;
}

function skipField(buffer: Buffer, wireType: number, offset: number): number {
  if (wireType === 0) {
    return readVarint(buffer, offset).offset;
  }

  if (wireType === 2) {
    const length = readVarint(buffer, offset);
    return length.offset + length.value;
  }

  throw new Error(`Unsupported protobuf wire type ${wireType}.`);
}

export function createHeadlessMetadataBootstrapPayload(
  options: HeadlessLanguageServerLaunchOptions = {},
): Buffer {
  const metadata = getAntigravityIDEMetadata();
  const parts = [
    encodeStringField(1, metadata.ideName),
    encodeStringField(3, options.accessToken ?? ""),
    encodeStringField(7, metadata.ideVersion),
    encodeStringField(12, metadata.ideName),
    encodeStringField(24, ""),
  ];

  if (options.disableTelemetry === true) {
    parts.push(encodeBoolField(6, true));
  }

  if (options.userTierId) {
    parts.push(encodeStringField(29, options.userTierId));
  }

  return Buffer.concat(parts);
}

function createHeadlessMetadataObject(): {
  ideName: string;
  ideVersion: string;
  extensionName: string;
  deviceFingerprint: string;
  apiKey: string;
} {
  const metadata = getAntigravityIDEMetadata();
  return {
    ideName: metadata.ideName,
    ideVersion: metadata.ideVersion,
    extensionName: metadata.ideName,
    deviceFingerprint: "",
    apiKey: "",
  };
}

function serializeHeadlessOAuthTokenInfo(info: HeadlessOAuthTokenInfo): string {
  const timestampPayload = Buffer.concat([
    encodeFieldKey(1, 0),
    encodeVarint(Math.max(0, Math.floor(info.expiryDateSeconds))),
  ]);
  const oauthPayload = Buffer.concat([
    encodeStringField(1, info.accessToken),
    encodeStringField(2, info.tokenType),
    encodeStringField(3, info.refreshToken),
    encodeMessageField(4, timestampPayload),
    encodeBoolField(6, info.isGcpTos),
  ]);
  return oauthPayload.toString("base64");
}

function createTopicJson(rows: Record<string, string>): { data: Record<string, { value: string }> } {
  return {
    data: Object.fromEntries(
      Object.entries(rows).map(([key, value]) => [
        key,
        { value },
      ]),
    ),
  };
}

function createTopicBinary(rows: Record<string, string>): Buffer {
  const entries = Object.entries(rows).map(([key, value]) => {
    const rowPayload = encodeStringField(1, value);
    const entryPayload = Buffer.concat([
      encodeStringField(1, key),
      encodeMessageField(2, rowPayload),
    ]);
    return encodeMessageField(1, entryPayload);
  });
  return Buffer.concat(entries);
}

export function decodeLanguageServerStartedRequest(buffer: Buffer): HeadlessLanguageServerStarted {
  const result: HeadlessLanguageServerStarted = {
    httpsPort: 0,
    httpPort: 0,
    lspPort: 0,
  };

  let offset = 0;
  while (offset < buffer.length) {
    const key = readVarint(buffer, offset);
    const fieldNumber = key.value >>> 3;
    const wireType = key.value & 0b111;
    offset = key.offset;

    if (fieldNumber === 1 && wireType === 0) {
      const value = readVarint(buffer, offset);
      result.httpsPort = value.value;
      offset = value.offset;
      continue;
    }

    if (fieldNumber === 2 && wireType === 0) {
      const value = readVarint(buffer, offset);
      result.lspPort = value.value;
      offset = value.offset;
      continue;
    }

    if (fieldNumber === 5 && wireType === 0) {
      const value = readVarint(buffer, offset);
      result.httpPort = value.value;
      offset = value.offset;
      continue;
    }

    offset = skipField(buffer, wireType, offset);
  }

  if (!result.httpsPort) {
    throw new Error("LanguageServerStarted request did not include httpsPort.");
  }

  return result;
}

function parseLanguageServerStartedBody(contentType: string | undefined, body: Buffer): HeadlessLanguageServerStarted {
  const normalized = contentType?.toLowerCase() ?? "";
  const payload = normalized.includes("connect+") ? unwrapConnectStreamingRequest(body) : body;
  if (normalized.includes("json")) {
    const parsed = JSON.parse(payload.toString("utf8") || "{}") as Partial<HeadlessLanguageServerStarted>;
    if (typeof parsed.httpsPort !== "number") {
      throw new Error("LanguageServerStarted JSON payload did not include httpsPort.");
    }
    return {
      httpsPort: parsed.httpsPort ?? 0,
      httpPort: parsed.httpPort ?? 0,
      lspPort: parsed.lspPort ?? 0,
    };
  }

  return decodeLanguageServerStartedRequest(payload);
}

function createEmptyUnaryResponse(requestContentType: string | undefined): {
  body: Buffer;
  contentType: string;
} {
  const normalized = requestContentType?.toLowerCase() ?? "";
  if (normalized.includes("json")) {
    return {
      body: Buffer.from("{}", "utf8"),
      contentType: "application/json",
    };
  }

  return {
    body: Buffer.alloc(0),
    contentType: "application/proto",
  };
}

function readRequestBody(request: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

class HeadlessExtensionServer {
  private readonly csrfToken = crypto.randomUUID();
  private readonly server = http.createServer(this.handleRequest.bind(this));
  private readonly unifiedStateTopics: Record<string, Record<string, string>>;
  private waiterResolve?: (started: HeadlessLanguageServerStarted) => void;
  private waiterReject?: (error: Error) => void;

  constructor(topics: Record<string, Record<string, string>>) {
    this.unifiedStateTopics = topics;
  }

  async listen(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        this.server.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        this.server.off("error", onError);
        resolve();
      };
      this.server.once("error", onError);
      this.server.once("listening", onListening);
      this.server.listen(0, "127.0.0.1");
    });
  }

  get port(): number {
    const address = this.server.address();
    if (!address || typeof address !== "object") {
      throw new Error("Headless Antigravity extension server is not listening.");
    }
    return address.port;
  }

  get token(): string {
    return this.csrfToken;
  }

  waitForLanguageServerStart(timeoutMs = 60_000): Promise<HeadlessLanguageServerStarted> {
    if (this.waiterResolve) {
      throw new Error("Already waiting for headless Antigravity language server startup.");
    }

    return new Promise<HeadlessLanguageServerStarted>((resolve, reject) => {
      let finished = false;
      const timeout = setTimeout(() => {
        if (finished) return;
        finished = true;
        this.waiterResolve = undefined;
        this.waiterReject = undefined;
        reject(new Error("Timed out waiting for headless Antigravity language server startup."));
      }, timeoutMs);

      this.waiterResolve = (started) => {
        if (finished) return;
        finished = true;
        clearTimeout(timeout);
        this.waiterResolve = undefined;
        this.waiterReject = undefined;
        resolve(started);
      };

      this.waiterReject = (error) => {
        if (finished) return;
        finished = true;
        clearTimeout(timeout);
        this.waiterResolve = undefined;
        this.waiterReject = undefined;
        reject(error);
      };
    });
  }

  async dispose(): Promise<void> {
    if (this.waiterReject) {
      this.waiterReject(new Error("Headless Antigravity extension server disposed."));
    }

    await new Promise<void>((resolve) => {
      this.server.close(() => resolve());
    });
  }

  private async handleRequest(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    if (request.headers["x-codeium-csrf-token"] !== this.csrfToken) {
      response.writeHead(403, { "content-type": "text/plain" });
      response.end("Invalid CSRF token");
      return;
    }

    if (request.method !== "POST") {
      response.writeHead(405, { "content-type": "text/plain" });
      response.end("Method not allowed");
      return;
    }

    const body = await readRequestBody(request).catch((error) => {
      response.writeHead(400, { "content-type": "text/plain" });
      response.end(error instanceof Error ? error.message : String(error));
      return null;
    });
    if (!body) {
      return;
    }

    try {
      if (request.url === LANGUAGE_SERVER_STARTED_PATH) {
        const started = parseLanguageServerStartedBody(request.headers["content-type"], body);
        this.waiterResolve?.(started);
        const unary = createEmptyUnaryResponse(request.headers["content-type"]);
        response.writeHead(200, {
          "content-type": unary.contentType,
          "connect-protocol-version": "1",
        });
        response.end(unary.body);
        return;
      }

      if (request.url === HEARTBEAT_PATH) {
        const unary = createEmptyUnaryResponse(request.headers["content-type"]);
        response.writeHead(200, {
          "content-type": unary.contentType,
          "connect-protocol-version": "1",
        });
        response.end(unary.body);
        return;
      }

      if (request.url === PUSH_UNIFIED_STATE_SYNC_UPDATE_PATH) {
        if (isHeadlessDebugEnabled()) {
          console.error(`[headless-ext] push update content-type=${request.headers["content-type"] ?? ""}`);
        }
        const unary = createEmptyUnaryResponse(request.headers["content-type"]);
        response.writeHead(200, {
          "content-type": unary.contentType,
          "connect-protocol-version": "1",
        });
        response.end(unary.body);
        return;
      }

      if (request.url === SUBSCRIBE_TO_UNIFIED_STATE_SYNC_TOPIC_PATH) {
        const normalized = request.headers["content-type"]?.toLowerCase() ?? "";
        const payload = normalized.includes("connect+") ? unwrapConnectStreamingRequest(body) : body;
        let topicName = "";

        if (normalized.includes("json")) {
          const parsed = JSON.parse(payload.toString("utf8") || "{}") as { topic?: string };
          topicName = parsed.topic ?? "";
        } else {
          let offset = 0;
          while (offset < payload.length) {
            const key = readVarint(payload, offset);
            const fieldNumber = key.value >>> 3;
            const wireType = key.value & 0b111;
            offset = key.offset;

            if (fieldNumber === 1 && wireType === 2) {
              const length = readVarint(payload, offset);
              topicName = payload.subarray(length.offset, length.offset + length.value).toString("utf8");
              offset = length.offset + length.value;
              break;
            }

            offset = skipField(payload, wireType, offset);
          }
        }

        const rows = this.unifiedStateTopics[topicName] ?? {};
        if (isHeadlessDebugEnabled()) {
          console.error(
            `[headless-ext] subscribe topic=${topicName || "<empty>"} content-type=${request.headers["content-type"] ?? ""} keys=${Object.keys(rows).join(",")}`,
          );
        }
        if (normalized.includes("json")) {
          response.writeHead(200, {
            "content-type": "application/connect+json",
            "connect-protocol-version": "1",
          });
          response.write(
            encodeConnectStreamFrame(
              0,
              Buffer.from(
                JSON.stringify({
                  updateType: {
                    case: "initialState",
                    value: createTopicJson(rows),
                  },
                }),
                "utf8",
              ),
            ),
          );
          response.write(encodeConnectStreamFrame(0b10, Buffer.from("{}", "utf8")));
          response.end();
          return;
        }

        response.writeHead(200, {
          "content-type": "application/connect+proto",
          "connect-protocol-version": "1",
        });
        response.write(
          encodeConnectStreamFrame(
            0,
            encodeMessageField(1, createTopicBinary(rows)),
          ),
        );
        response.write(encodeConnectStreamFrame(0b10, Buffer.alloc(0)));
        response.end();
        return;
      }

      response.writeHead(404, { "content-type": "text/plain" });
      response.end(`Unsupported Antigravity extension-server path: ${request.url ?? ""}`);
    } catch (error) {
      response.writeHead(500, { "content-type": "text/plain" });
      response.end(error instanceof Error ? error.message : String(error));
    }
  }
}

async function resolveAntigravityAppRoot(): Promise<string> {
  await initAntigravityRuntimeMetadata();

  const appRoot = findLocalAntigravityAppRoot();
  if (appRoot) {
    return appRoot;
  }

  const standardAppRoot = process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, "Programs", "Antigravity", "resources", "app")
    : path.join(os.homedir(), "AppData", "Local", "Programs", "Antigravity", "resources", "app");
  const standardBinaryName = getLanguageServerBinaryName();
  const standardBinaryPath = standardBinaryName
    ? path.join(standardAppRoot, "extensions", "antigravity", "bin", standardBinaryName)
    : undefined;

  if (existsSync(path.join(standardAppRoot, "product.json")) || (standardBinaryPath && existsSync(standardBinaryPath))) {
    return standardAppRoot;
  }

  throw new Error("Antigravity app root not found. Install Antigravity or set OPENCODE_ANTIGRAVITY_APP_DIR.");
}

function sendHeadlessHeartbeat(port: number, csrfToken: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = https.request(
      {
        host: "127.0.0.1",
        port,
        path: LANGUAGE_SERVER_HEARTBEAT_PATH,
        method: "POST",
        rejectUnauthorized: false,
        headers: {
          "connect-protocol-version": "1",
          "content-type": "application/json",
          "x-codeium-csrf-token": csrfToken,
          "user-agent": getAntigravityUserAgent(),
        },
      },
      (response) => {
        response.resume();
        if ((response.statusCode ?? 0) >= 200 && (response.statusCode ?? 0) < 300) {
          resolve();
          return;
        }
        reject(new Error(`Headless Antigravity heartbeat failed with HTTP ${response.statusCode ?? 0}.`));
      },
    );

    request.on("error", reject);
    request.write(JSON.stringify({ metadata: createHeadlessMetadataObject() }));
    request.end();
  });
}

export async function launchHeadlessAntigravityLanguageServer(
  options: HeadlessLanguageServerLaunchOptions = {},
): Promise<HeadlessLanguageServerHandle> {
  const appRoot = await resolveAntigravityAppRoot();
  const binaryPath = getLanguageServerBinaryPath(appRoot);
  const unifiedStateTopics: Record<string, Record<string, string>> = {};
  if (options.oauthTokenInfo) {
    unifiedStateTopics[OAUTH_TOPIC_NAME] = {
      [OAUTH_TOPIC_KEY]: serializeHeadlessOAuthTokenInfo(options.oauthTokenInfo),
    };
  }

  const extensionServer = new HeadlessExtensionServer(unifiedStateTopics);
  await extensionServer.listen();

  const csrfToken = crypto.randomUUID();
  const args = [
    "--csrf_token",
    csrfToken,
    "--extension_server_port",
    String(extensionServer.port),
    "--extension_server_csrf_token",
    extensionServer.token,
    "--app_data_dir",
    "antigravity",
    "--cloud_code_endpoint",
    resolveCloudCodeBaseUrl(),
  ];

  const child = spawn(binaryPath, args, {
    cwd: undefined,
    detached: false,
    env: {
      ...process.env,
      ANTIGRAVITY_EDITOR_APP_ROOT: appRoot,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  let stderr = "";
  let stdout = "";
  const recordOutput = (chunk: Buffer | string, target: "stdout" | "stderr") => {
    const next = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    if (target === "stderr") {
      stderr = `${stderr}${next}`.slice(-8000);
      return;
    }
    stdout = `${stdout}${next}`.slice(-8000);
  };

  child.stdout.on("data", (chunk) => recordOutput(chunk, "stdout"));
  child.stderr.on("data", (chunk) => recordOutput(chunk, "stderr"));

  const exitPromise = new Promise<never>((_, reject) => {
    child.once("exit", (code, signal) => {
      reject(
        new Error(
          [
            `Headless Antigravity language server exited before startup (code=${code ?? "null"}, signal=${signal ?? "null"}).`,
            stdout ? `stdout:\n${stdout}` : "",
            stderr ? `stderr:\n${stderr}` : "",
          ]
            .filter(Boolean)
            .join("\n\n"),
        ),
      );
    });
    child.once("error", (error) => {
      reject(error);
    });
  });

  child.stdin.write(createHeadlessMetadataBootstrapPayload(options));
  child.stdin.end();

  let started: HeadlessLanguageServerStarted;
  try {
    started = await Promise.race([extensionServer.waitForLanguageServerStart(), exitPromise]);
  } catch (error) {
    child.kill("SIGTERM");
    await extensionServer.dispose();
    throw error;
  }

  await sendHeadlessHeartbeat(started.httpsPort, csrfToken);
  const heartbeatInterval = setInterval(() => {
    void sendHeadlessHeartbeat(started.httpsPort, csrfToken).catch(() => undefined);
  }, HEARTBEAT_INTERVAL_MS);

  child.once("exit", () => {
    clearInterval(heartbeatInterval);
    void extensionServer.dispose();
  });

  const commandLine = [binaryPath, ...args].join(" ");

  return {
    appRoot,
    binaryPath,
    commandLine,
    csrfToken,
    process: child,
    port: started.httpsPort,
    processId: child.pid ?? 0,
    dispose: async () => {
      clearInterval(heartbeatInterval);
      if (child.pid && child.exitCode === null) {
        if (process.platform === "win32") {
          spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
            windowsHide: true,
            stdio: "ignore",
          });
        } else if (!child.killed) {
          child.kill("SIGTERM");
        }
      }
      await extensionServer.dispose();
    },
    isAlive: () => child.exitCode === null && !child.killed,
  };
}
