import * as crypto from "node:crypto";

import type { Hooks, PluginInput } from "@opencode-ai/plugin";

import {
  clearAntigravityBridgeCredentialCache,
  evictHeadlessBridgeAccount,
  getAntigravityBridgeCredentials,
  markHeadlessBridgeAccountFailure,
  shutdownAntigravityBridgeHeadlessServer,
  type AntigravityBridgeCredentials,
} from "./auth";
import {
  type BridgeChatCompletionRequest,
  runBridgeTurn,
  startBridgeConversation,
  type BridgeSessionState,
} from "./connect";
import { listAntigravityBridgeModels } from "./models";
import { isBridgeRotationError } from "./pool";
import {
  handleBridgeToolPlanning,
  handleBridgeToolPlanningStream,
  requestUsesToolPlanning,
  type BridgeToolPlanningState,
  type BridgeToolPlanningRequest,
} from "./tool-planning";
import {
  getAntigravityBridgeCleanupOnExit,
  initAntigravityBridgeRuntimeOptions,
} from "./options";
import { getBridgeDebugLogFilePath, logBridgeDebug } from "./debug";

const BRIDGE_HOST = "127.0.0.1";
const BRIDGE_DEFAULT_PORT = 43110;
const SESSION_TTL_MS = 30 * 60 * 1000;
const GLOBAL_SERVER_KEY = "__opencode_antigravity_bridge_server__";
const GLOBAL_CLEANUP_KEY = "__opencode_antigravity_bridge_cleanup__";

type ChatCompletionChoice = {
  index: number;
  message?: {
    role: "assistant";
    content: string;
    reasoning_text?: string;
  };
  delta?: {
    content?: string;
    reasoning_text?: string;
  };
  finish_reason: string | null;
};

type BridgeChatRequest = BridgeChatCompletionRequest & {
  stream?: boolean;
  tools?: Array<Record<string, unknown>>;
  providerOptions?: Record<string, unknown>;
};

type ProxyBridgeSessionState = BridgeSessionState &
  BridgeToolPlanningState & {
  credentials: AntigravityBridgeCredentials;
  accountKey?: string;
};

const bridgeSessions = new Map<string, ProxyBridgeSessionState>();

function cleanupBridgeSessions(): void {
  const cutoff = Date.now() - SESSION_TTL_MS;
  for (const [key, session] of bridgeSessions) {
    if (session.lastUsedAt < cutoff) {
      bridgeSessions.delete(key);
    }
  }
}

function createErrorResponse(status: number, message: string, details?: string): Response {
  return new Response(
    JSON.stringify({
      error: {
        message: details ? `${message}\n${details}` : message,
        type: "antigravity_bridge_error",
      },
    }),
    {
      status,
      headers: {
        "content-type": "application/json",
      },
    },
  );
}

function getSessionId(request: Request): string {
  const sessionId =
    request.headers.get("x-opencode-session")?.trim() ||
    request.headers.get("x-session-affinity")?.trim() ||
    request.headers.get("x-opencode-session-id")?.trim();

  return sessionId || crypto.randomUUID();
}

function getWorkspaceUri(directory: string): string {
  const normalized = directory.replace(/\//g, "\\");
  const driveMatch = normalized.match(/^([A-Za-z]):\\(.*)$/);
  if (driveMatch) {
    const drive = driveMatch[1]!.toLowerCase();
    const remainder = driveMatch[2]!.split("\\").filter(Boolean).map(encodeURIComponent).join("/");
    return `file:///${drive}%3A/${remainder}`;
  }

  const slashPath = normalized.replace(/\\/g, "/").split("/").map(encodeURIComponent).join("/");
  return `file:///${slashPath}`;
}

async function getOrCreateBridgeSession(
  sessionId: string,
  directory: string,
  preferredAccountKey?: string,
  excludedAccountKeys: string[] = [],
): Promise<ProxyBridgeSessionState> {
  cleanupBridgeSessions();

  const workspaceUri = getWorkspaceUri(directory);
  const existing = bridgeSessions.get(sessionId);
  if (existing && existing.workspaceUri === workspaceUri && (!preferredAccountKey || existing.accountKey === preferredAccountKey)) {
    existing.lastUsedAt = Date.now();
    logBridgeDebug("bridge-session-reuse", {
      sessionId,
      workspaceUri,
      accountKey: existing.accountKey?.slice(-8),
      processId: existing.credentials.processId,
      port: existing.credentials.port,
    });
    return existing;
  }

  clearAntigravityBridgeCredentialCache();
  const credentials = await getAntigravityBridgeCredentials(directory, {
    accountKey: preferredAccountKey,
    excludedAccountKeys,
  });
  const conversationId = await startBridgeConversation(credentials, workspaceUri);
  const state: ProxyBridgeSessionState = {
    conversationId,
    workspaceUri,
    lastUsedAt: Date.now(),
    chain: Promise.resolve(),
    credentials,
    accountKey: credentials.accountKey,
  };
  bridgeSessions.set(sessionId, state);
  logBridgeDebug("bridge-session-created", {
    sessionId,
    workspaceUri,
    accountKey: credentials.accountKey?.slice(-8),
    processId: credentials.processId,
    port: credentials.port,
    conversationId,
  });
  return state;
}

function withSessionLock<T>(session: BridgeSessionState, task: () => Promise<T>): Promise<T> {
  const previous = session.chain;
  let release: () => void = () => {};
  session.chain = new Promise<void>((resolve) => {
    release = resolve;
  });

  return previous
    .catch(() => undefined)
    .then(task)
    .finally(() => {
      session.lastUsedAt = Date.now();
      release();
    });
}

function createStreamingResponse(requestedModel: string, task: (enqueue: (delta: { type: "text" | "reasoning"; text: string }) => void) => Promise<void>): Response {
  const encoder = new TextEncoder();
  const responseId = `chatcmpl-${crypto.randomUUID()}`;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        await task((delta) => {
          const chunk = {
            id: responseId,
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model: requestedModel,
            choices: [
              {
                index: 0,
                delta: delta.type === "reasoning" ? { reasoning_text: delta.text } : { content: delta.text },
                finish_reason: null,
              } satisfies ChatCompletionChoice,
            ],
          };
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
        });

        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({
              id: responseId,
              object: "chat.completion.chunk",
              created: Math.floor(Date.now() / 1000),
              model: requestedModel,
              choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            })}\n\n`,
          ),
        );
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: { message } })}\n\n`));
        controller.close();
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
}

async function handleChatCompletion(input: PluginInput, request: Request): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as BridgeToolPlanningRequest;
  const sessionId = getSessionId(request);
  const session = await getOrCreateBridgeSession(sessionId, input.directory);
  const requestedModel = body.model?.trim() || "antigravity-bridge";
  logBridgeDebug("bridge-chat-request", {
    sessionId,
    model: requestedModel,
    stream: body.stream === true,
    toolCount: Array.isArray(body.tools) ? body.tools.length : 0,
    messageCount: Array.isArray(body.messages) ? body.messages.length : 0,
    logFilePath: getBridgeDebugLogFilePath(),
  });

  async function retryWithRotatedAccount(error: unknown): Promise<ProxyBridgeSessionState> {
    const message = error instanceof Error ? error.message : String(error);
    if (!session.accountKey || !isBridgeRotationError(message)) {
      throw error;
    }
    await markHeadlessBridgeAccountFailure(session.accountKey, message);
    await evictHeadlessBridgeAccount(session.accountKey);
    bridgeSessions.delete(sessionId);
    clearAntigravityBridgeCredentialCache();
    try {
      return await getOrCreateBridgeSession(sessionId, input.directory, undefined, [session.accountKey]);
    } catch {
      throw error;
    }
  }

  if (requestUsesToolPlanning(body)) {
    logBridgeDebug("bridge-tool-planning-selected", {
      sessionId,
      model: requestedModel,
      toolCount: Array.isArray(body.tools) ? body.tools.length : 0,
    });
    if (body.stream) {
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          try {
            await withSessionLock(session, async () => {
              const upstream = handleBridgeToolPlanningStream(session.credentials, session.workspaceUri, body, session);
              const reader = upstream.getReader();
              while (true) {
                const { done, value } = await reader.read();
                if (done) {
                  break;
                }
                if (value) {
                  controller.enqueue(value);
                }
              }
            });
            controller.close();
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: { message } })}\n\n`));
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
          }
        },
      });
      return new Response(stream, {
        status: 200,
        headers: {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        },
      });
    }

    try {
      return await withSessionLock(session, async () =>
        handleBridgeToolPlanning(session.credentials, session.workspaceUri, body, session),
      );
    } catch (error) {
      logBridgeDebug("bridge-tool-planning-error", {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
      try {
        const retrySession = await retryWithRotatedAccount(error);
        return await withSessionLock(retrySession, async () =>
          handleBridgeToolPlanning(retrySession.credentials, retrySession.workspaceUri, body, retrySession),
        );
      } catch (retryError) {
        return createErrorResponse(500, "Antigravity bridge tool planning failed", retryError instanceof Error ? retryError.message : String(retryError));
      }
    }
  }

  if (body.stream) {
    return createStreamingResponse(requestedModel, async (enqueue) => {
      let emitted = false;
      const forwardDelta = (delta: { type: "text" | "reasoning"; text: string }) => {
        emitted = true;
        enqueue(delta);
      };

      try {
        await withSessionLock(session, async () => {
          await runBridgeTurn(session.credentials, session.conversationId, body, {
            onDelta: forwardDelta,
          });
        });
      } catch (error) {
        logBridgeDebug("bridge-chat-stream-error", {
          sessionId,
          emitted,
          error: error instanceof Error ? error.message : String(error),
        });
        if (emitted) {
          throw error;
        }

        const retrySession = await retryWithRotatedAccount(error);
        await withSessionLock(retrySession, async () => {
          await runBridgeTurn(retrySession.credentials, retrySession.conversationId, body, {
            onDelta: forwardDelta,
          });
        });
      }
    });
  }

  try {
    const result = await withSessionLock(session, async () => runBridgeTurn(session.credentials, session.conversationId, body));
    logBridgeDebug("bridge-chat-success", {
      sessionId,
      accountKey: session.accountKey?.slice(-8),
      textLength: result.text.length,
      reasoningLength: result.reasoning.length,
    });
    return new Response(
      JSON.stringify({
        id: `chatcmpl-${crypto.randomUUID()}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: requestedModel,
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: result.text,
              ...(result.reasoning ? { reasoning_text: result.reasoning } : {}),
            },
            finish_reason: "stop",
          },
        ],
      }),
      {
        status: 200,
        headers: {
          "content-type": "application/json",
        },
      },
    );
  } catch (error) {
    logBridgeDebug("bridge-chat-error", {
      sessionId,
      error: error instanceof Error ? error.message : String(error),
    });
    try {
      const retrySession = await retryWithRotatedAccount(error);
      const result = await withSessionLock(retrySession, async () => runBridgeTurn(retrySession.credentials, retrySession.conversationId, body));
      logBridgeDebug("bridge-chat-success-after-rotation", {
        sessionId,
        accountKey: retrySession.accountKey?.slice(-8),
        textLength: result.text.length,
        reasoningLength: result.reasoning.length,
      });
      return new Response(
        JSON.stringify({
          id: `chatcmpl-${crypto.randomUUID()}`,
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: requestedModel,
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: result.text,
                ...(result.reasoning ? { reasoning_text: result.reasoning } : {}),
              },
              finish_reason: "stop",
            },
          ],
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        },
      );
    } catch (retryError) {
      return createErrorResponse(500, "Antigravity bridge chat completion failed", retryError instanceof Error ? retryError.message : String(retryError));
    }
  }
}

export function createBridgeRequestHandler(input: PluginInput): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      try {
        const credentials = await getAntigravityBridgeCredentials(process.cwd());
        return new Response(
          JSON.stringify({ ok: true, available: true, port: credentials.port, processId: credentials.processId }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      } catch (error) {
        return new Response(
          JSON.stringify({
            ok: true,
            available: false,
            error: error instanceof Error ? error.message : String(error),
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
    }

    if (url.pathname === "/v1/models" || url.pathname === "/models") {
      return new Response(
        JSON.stringify({
          object: "list",
          data: listAntigravityBridgeModels().map((model) => ({
            id: model.id,
            object: "model",
            created: Math.floor(Date.now() / 1000),
            owned_by: "antigravity-local",
            description: model.description,
          })),
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }

    if (url.pathname === "/v1/chat/completions" || url.pathname === "/chat/completions") {
      return handleChatCompletion(input, request);
    }

    return createErrorResponse(404, `Unsupported bridge path: ${url.pathname}`);
  };
}

async function ensureBridgeServer(): Promise<string> {
  const globalState = globalThis as Record<string, any>;
  const existing = globalState[GLOBAL_SERVER_KEY]?.baseURL;
  if (typeof existing === "string" && existing) {
    return existing;
  }

  const bun = globalState.Bun;
  if (!bun?.serve) {
    throw new Error("Antigravity bridge requires Bun runtime.");
  }

  const handler = (request: Request): Promise<Response> =>
    createBridgeRequestHandler(globalState[`${GLOBAL_SERVER_KEY}:input`] as PluginInput)(request);

  const server = (() => {
    try {
      return bun.serve({
        hostname: BRIDGE_HOST,
        port: BRIDGE_DEFAULT_PORT,
        fetch: handler,
        idleTimeout: 120,
      });
    } catch (error) {
      logBridgeDebug("bridge-server-default-port-failed", {
        port: BRIDGE_DEFAULT_PORT,
        error: error instanceof Error ? error.message : String(error),
      });
      return bun.serve({
        hostname: BRIDGE_HOST,
        port: 0,
        fetch: handler,
        idleTimeout: 120,
      });
    }
  })();

  const baseURL = `http://${BRIDGE_HOST}:${server.port}/v1`;
  globalState[GLOBAL_SERVER_KEY] = { server, baseURL };
  logBridgeDebug("bridge-server-started", {
    baseURL,
    port: server.port,
  });
  return baseURL;
}

function ensureBridgeCleanupHooks(): void {
  const globalState = globalThis as Record<string, any>;
  if (globalState[GLOBAL_CLEANUP_KEY]) {
    return;
  }
  globalState[GLOBAL_CLEANUP_KEY] = true;

  const shutdown = async () => {
    try {
      await shutdownAntigravityBridgeHeadlessServer();
    } catch {
      // ignore cleanup failures
    }
  };

  process.once("beforeExit", () => {
    void shutdown();
  });

  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.once(signal, () => {
      void shutdown().finally(() => process.exit(0));
    });
  }
}

export function createAntigravityServerBridgePlugin(providerId = "antigravity-bridge") {
  return async (input: PluginInput, options?: Record<string, unknown>): Promise<Hooks> => {
    initAntigravityBridgeRuntimeOptions(options);
    logBridgeDebug("bridge-plugin-init", {
      providerId,
      directory: input.directory,
      debugLogPath: getBridgeDebugLogFilePath(),
    });
    (globalThis as Record<string, any>)[`${GLOBAL_SERVER_KEY}:input`] = input;
    if (getAntigravityBridgeCleanupOnExit()) {
      ensureBridgeCleanupHooks();
    }
    const proxyBaseUrl = await ensureBridgeServer();
    process.env.OPENCODE_ANTIGRAVITY_BRIDGE_BASE_URL = proxyBaseUrl;
    logBridgeDebug("bridge-server-ready", {
      providerId,
      proxyBaseUrl,
      debugLogPath: getBridgeDebugLogFilePath(),
    });

    return {
      config: async (config) => {
        config.provider = config.provider || {};
        const existing = (config.provider[providerId] || {}) as Record<string, unknown>;
        const providerOptions = ((existing.options as Record<string, unknown> | undefined) || {});
        config.provider[providerId] = {
          ...existing,
          npm: "@ai-sdk/github-copilot",
          api: proxyBaseUrl,
          options: {
            ...providerOptions,
            baseURL: proxyBaseUrl,
            apiKey: (providerOptions.apiKey as string | undefined) || "antigravity-bridge-local",
          },
        };
      },
      provider: {
        id: providerId,
        models: async (provider) =>
          Object.fromEntries(
            Object.entries(provider.models ?? {}).map(([modelID, model]) => [
              modelID,
              {
                ...model,
                api: {
                  ...(model.api ?? {}),
                  url: proxyBaseUrl,
                  npm: "@ai-sdk/github-copilot",
                },
              },
            ]),
          ),
      },
      auth: {
        provider: providerId,
        async loader() {
          return {
            baseURL: proxyBaseUrl,
            apiKey: "antigravity-bridge-local",
          };
        },
        methods: [],
      },
      "chat.params": async (incoming, output) => {
        if (incoming.model.providerID !== providerId) {
          return;
        }
        output.options = output.options || {};
        output.options.baseURL = proxyBaseUrl;
        output.options.apiKey = output.options.apiKey || "antigravity-bridge-local";
      },
      "chat.headers": async (incoming, output) => {
        if (incoming.model.providerID !== providerId) {
          return;
        }
        output.headers["x-opencode-session-id"] = incoming.sessionID;
      },
    };
  };
}

export const AntigravityBridgePlugin = createAntigravityServerBridgePlugin("antigravity-bridge");
export const AntigravityServerBridgePlugin = createAntigravityServerBridgePlugin("antigravity-server-bridge");
