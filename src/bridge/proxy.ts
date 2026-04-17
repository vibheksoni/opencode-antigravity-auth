import * as crypto from "node:crypto";

import type { Hooks, PluginInput } from "@opencode-ai/plugin";

import { clearAntigravityBridgeCredentialCache, getAntigravityBridgeCredentials } from "./auth";
import {
  type BridgeChatCompletionRequest,
  runBridgeTurn,
  startBridgeConversation,
  type BridgeSessionState,
} from "./connect";
import { listAntigravityBridgeModels } from "./models";

const BRIDGE_HOST = "127.0.0.1";
const BRIDGE_DEFAULT_PORT = 43110;
const SESSION_TTL_MS = 30 * 60 * 1000;
const GLOBAL_SERVER_KEY = "__opencode_antigravity_bridge_server__";

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
};

const bridgeSessions = new Map<string, BridgeSessionState>();

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
  return request.headers.get("x-opencode-session-id")?.trim() || crypto.randomUUID();
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

async function getOrCreateBridgeSession(sessionId: string, directory: string): Promise<BridgeSessionState> {
  cleanupBridgeSessions();

  const workspaceUri = getWorkspaceUri(directory);
  const existing = bridgeSessions.get(sessionId);
  if (existing && existing.workspaceUri === workspaceUri) {
    existing.lastUsedAt = Date.now();
    return existing;
  }

  clearAntigravityBridgeCredentialCache();
  const credentials = await getAntigravityBridgeCredentials(directory);
  const conversationId = await startBridgeConversation(credentials, workspaceUri);
  const state: BridgeSessionState = {
    conversationId,
    workspaceUri,
    lastUsedAt: Date.now(),
    chain: Promise.resolve(),
  };
  bridgeSessions.set(sessionId, state);
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
  const body = (await request.json().catch(() => ({}))) as BridgeChatRequest;
  const sessionId = getSessionId(request);
  const session = await getOrCreateBridgeSession(sessionId, input.directory);
  const credentials = await getAntigravityBridgeCredentials(input.directory);
  const requestedModel = body.model?.trim() || "antigravity-bridge";

  if (body.stream) {
    return createStreamingResponse(requestedModel, async (enqueue) => {
      await withSessionLock(session, async () => {
        await runBridgeTurn(credentials, session.conversationId, body, {
          onDelta: enqueue,
        });
      });
    });
  }

  try {
    const result = await withSessionLock(session, async () => runBridgeTurn(credentials, session.conversationId, body));
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
    return createErrorResponse(500, "Antigravity bridge chat completion failed", error instanceof Error ? error.message : String(error));
  }
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

  const handler = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      try {
        const credentials = await getAntigravityBridgeCredentials(process.cwd());
        return new Response(
          JSON.stringify({ ok: true, port: credentials.port, processId: credentials.processId }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      } catch (error) {
        return createErrorResponse(503, "Antigravity bridge unavailable", error instanceof Error ? error.message : String(error));
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
      return handleChatCompletion(globalState[`${GLOBAL_SERVER_KEY}:input`] as PluginInput, request);
    }

    return createErrorResponse(404, `Unsupported bridge path: ${url.pathname}`);
  };

  try {
    const response = await fetch(`http://${BRIDGE_HOST}:${BRIDGE_DEFAULT_PORT}/health`).catch(() => null);
    if (response?.ok) {
      const baseURL = `http://${BRIDGE_HOST}:${BRIDGE_DEFAULT_PORT}/v1`;
      globalState[GLOBAL_SERVER_KEY] = { baseURL };
      return baseURL;
    }
  } catch {
    // ignore existing probe failure
  }

  const server = bun.serve({
    hostname: BRIDGE_HOST,
    port: BRIDGE_DEFAULT_PORT,
    fetch: handler,
    idleTimeout: 120,
  });

  const baseURL = `http://${BRIDGE_HOST}:${server.port}/v1`;
  globalState[GLOBAL_SERVER_KEY] = { server, baseURL };
  return baseURL;
}

export function createAntigravityServerBridgePlugin(providerId = "antigravity-bridge") {
  return async (input: PluginInput): Promise<Hooks> => {
    (globalThis as Record<string, any>)[`${GLOBAL_SERVER_KEY}:input`] = input;
    const proxyBaseUrl = await ensureBridgeServer();

    return {
      auth: {
        provider: providerId,
        async loader() {
          return {};
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
