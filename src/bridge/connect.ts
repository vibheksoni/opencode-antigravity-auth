import * as crypto from "node:crypto";
import * as https from "node:https";

import { getAntigravityBridgeUserAgent, type AntigravityBridgeCredentials } from "./auth";
import { resolveAntigravityBridgeRequestedModel } from "./models";

export interface BridgeChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | Array<{ type?: string; text?: string }>;
}

export interface BridgeChatCompletionRequest {
  model?: string;
  messages?: BridgeChatMessage[];
}

export interface BridgeDelta {
  type: "text" | "reasoning";
  text: string;
}

export interface BridgeTurnResult {
  text: string;
  reasoning: string;
}

export interface BridgeSessionState {
  conversationId: string;
  workspaceUri: string;
  lastUsedAt: number;
  chain: Promise<void>;
}

type ConnectFrame = {
  flags: number;
  payload: string;
};

type StreamHandlers = {
  onDelta?: (delta: BridgeDelta) => void;
};

const DEFAULT_TURN_TIMEOUT_MS = 120_000;
const STREAM_CONTENT_TYPE = "application/connect+json";
const STREAM_PATH = "/exa.language_server_pb.LanguageServerService/StreamAgentStateUpdates";
const START_PATH = "/exa.language_server_pb.LanguageServerService/StartCascade";
const SEND_PATH = "/exa.language_server_pb.LanguageServerService/SendUserCascadeMessage";

function encodeConnectJsonFrame(value: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(value), "utf8");
  const frame = Buffer.alloc(5 + payload.length);
  frame[0] = 0;
  frame.writeUInt32BE(payload.length, 1);
  payload.copy(frame, 5);
  return frame;
}

export function parseConnectFrames(buffer: Buffer): {
  frames: ConnectFrame[];
  remaining: Buffer;
} {
  const frames: ConnectFrame[] = [];
  let offset = 0;

  while (offset + 5 <= buffer.length) {
    const flags = buffer[offset]!;
    const length = buffer.readUInt32BE(offset + 1);
    if (offset + 5 + length > buffer.length) {
      break;
    }
    const payload = buffer.subarray(offset + 5, offset + 5 + length).toString("utf8");
    frames.push({ flags, payload });
    offset += 5 + length;
  }

  return {
    frames,
    remaining: buffer.subarray(offset),
  };
}

function extractTextContent(content: BridgeChatMessage["content"]): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((part) => (typeof part?.text === "string" ? part.text : ""))
    .filter(Boolean)
    .join("\n");
}

export function buildBridgePrompt(request: BridgeChatCompletionRequest): string {
  const messages = request.messages ?? [];
  const reversedUser = [...messages].reverse().find((message) => message.role === "user");
  if (reversedUser) {
    return extractTextContent(reversedUser.content);
  }

  return messages
    .map((message) => {
      const text = extractTextContent(message.content);
      return text ? `${message.role.toUpperCase()}: ${text}` : "";
    })
    .filter(Boolean)
    .join("\n\n");
}

function postUnaryJson(
  credentials: AntigravityBridgeCredentials,
  path: string,
  body: unknown,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = https.request(
      {
        host: "127.0.0.1",
        port: credentials.port,
        path,
        method: "POST",
        rejectUnauthorized: false,
        headers: {
          "connect-protocol-version": "1",
          "content-type": "application/json",
          "x-codeium-csrf-token": credentials.csrfToken,
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

export function extractPlannerUpdate(update: any): {
  messageId?: string;
  response?: string;
  thinking?: string;
  status?: string;
  errorMessage?: string;
} {
  const source = update?.update ?? update;
  const steps = source?.mainTrajectoryUpdate?.stepsUpdate?.steps;
  const plannerStep = Array.isArray(steps)
    ? [...steps]
        .reverse()
        .find((step) => step?.type === "CORTEX_STEP_TYPE_PLANNER_RESPONSE" && step?.plannerResponse)
    : undefined;

  const plannerResponse = plannerStep?.plannerResponse;
  const errorMessage =
    source?.mainTrajectoryUpdate?.lastStepError?.message ??
    source?.lastStepError?.message;

  return {
    messageId: plannerResponse?.messageId,
    response: plannerResponse?.modifiedResponse ?? plannerResponse?.response,
    thinking: plannerResponse?.thinking,
    status: source?.status,
    errorMessage: errorMessage || undefined,
  };
}

function emitDiff(
  type: "text" | "reasoning",
  nextValue: string | undefined,
  previousValue: string,
  onDelta: StreamHandlers["onDelta"],
): string {
  const normalized = nextValue ?? "";
  if (!normalized.startsWith(previousValue)) {
    if (normalized) {
      onDelta?.({ type, text: normalized });
    }
    return normalized;
  }

  const delta = normalized.slice(previousValue.length);
  if (delta) {
    onDelta?.({ type, text: delta });
  }
  return normalized;
}

export async function startBridgeConversation(
  credentials: AntigravityBridgeCredentials,
  workspaceUri: string,
): Promise<string> {
  const response = await postUnaryJson(credentials, START_PATH, {
    source: "CORTEX_TRAJECTORY_SOURCE_CASCADE_CLIENT",
    cascadeId: crypto.randomUUID(),
    workspaceUris: [workspaceUri],
  });

  if (response.status !== 200) {
    throw new Error(`StartCascade failed with HTTP ${response.status}`);
  }

  const parsed = JSON.parse(response.body || "{}") as { cascadeId?: string };
  if (!parsed.cascadeId) {
    throw new Error("StartCascade did not return cascadeId");
  }
  return parsed.cascadeId;
}

async function sendUserMessage(
  credentials: AntigravityBridgeCredentials,
  conversationId: string,
  prompt: string,
  model: string | undefined,
): Promise<void> {
  const requestedModel = resolveAntigravityBridgeRequestedModel(model);
  const response = await postUnaryJson(credentials, SEND_PATH, {
    cascadeId: conversationId,
    items: [{ text: prompt }],
    cascadeConfig: {
      plannerConfig: {
        conversational: {
          plannerMode: "CONVERSATIONAL_PLANNER_MODE_DEFAULT",
          agenticMode: false,
        },
        toolConfig: {
          runCommand: {
            autoCommandConfig: {
              autoExecutionPolicy: "CASCADE_COMMANDS_AUTO_EXECUTION_OFF",
            },
          },
          notifyUser: {
            artifactReviewMode: "ARTIFACT_REVIEW_MODE_ALWAYS",
          },
        },
        requestedModel: {
          model: requestedModel,
        },
        ephemeralMessagesConfig: {
          enabled: true,
        },
        knowledgeConfig: {
          enabled: true,
        },
      },
      conversationHistoryConfig: {
        enabled: true,
      },
    },
    clientType: "CHAT_CLIENT_REQUEST_STREAM_CLIENT_TYPE_IDE",
  });

  if (response.status !== 200) {
    throw new Error(`SendUserCascadeMessage failed with HTTP ${response.status}`);
  }
}

export async function runBridgeTurn(
  credentials: AntigravityBridgeCredentials,
  conversationId: string,
  request: BridgeChatCompletionRequest,
  handlers: StreamHandlers = {},
): Promise<BridgeTurnResult> {
  const prompt = buildBridgePrompt(request);
  if (!prompt) {
    throw new Error("Antigravity bridge could not find a user prompt to send.");
  }

  return new Promise<BridgeTurnResult>((resolve, reject) => {
    let responseText = "";
    let reasoningText = "";
    let activeMessageId: string | undefined;
    let sawPlannerUpdate = false;
    let finished = false;
    let buffer: Buffer = Buffer.alloc(0) as Buffer;

    const timeout = setTimeout(() => {
      if (finished) {
        return;
      }
      finished = true;
      reject(new Error("Timed out waiting for Antigravity bridge response."));
    }, DEFAULT_TURN_TIMEOUT_MS);

    const finish = () => {
      if (finished) {
        return;
      }
      finished = true;
      clearTimeout(timeout);
      resolve({
        text: responseText,
        reasoning: reasoningText,
      });
    };

    const fail = (error: Error) => {
      if (finished) {
        return;
      }
      finished = true;
      clearTimeout(timeout);
      reject(error);
    };

    const streamRequest = https.request(
      {
        host: "127.0.0.1",
        port: credentials.port,
        path: STREAM_PATH,
        method: "POST",
        rejectUnauthorized: false,
        headers: {
          "connect-protocol-version": "1",
          "content-type": STREAM_CONTENT_TYPE,
          "x-codeium-csrf-token": credentials.csrfToken,
          "user-agent": getAntigravityBridgeUserAgent(),
        },
      },
      (response) => {
        if (response.statusCode !== 200) {
          response.resume();
          fail(new Error(`StreamAgentStateUpdates failed with HTTP ${response.statusCode ?? 0}`));
          return;
        }

        response.on("data", (chunk) => {
          const nextChunk = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          buffer = Buffer.concat([buffer, nextChunk]);
          const parsed = parseConnectFrames(buffer);
          buffer = parsed.remaining as Buffer;

          for (const frame of parsed.frames) {
            let payload: any;
            try {
              payload = JSON.parse(frame.payload || "{}");
            } catch {
              continue;
            }

            if ((frame.flags & 0b10) !== 0) {
              if (payload?.error?.message) {
                fail(new Error(payload.error.message));
                return;
              }
              continue;
            }

            const planner = extractPlannerUpdate(payload.update);
            if (planner.errorMessage) {
              fail(new Error(planner.errorMessage));
              return;
            }

            if (planner.messageId) {
              if (!activeMessageId) {
                activeMessageId = planner.messageId;
              }
              if (activeMessageId !== planner.messageId) {
                continue;
              }
            }

            if (planner.thinking || planner.response) {
              sawPlannerUpdate = true;
              reasoningText = emitDiff("reasoning", planner.thinking, reasoningText, handlers.onDelta);
              responseText = emitDiff("text", planner.response, responseText, handlers.onDelta);
            }

            if (planner.status === "CASCADE_RUN_STATUS_IDLE" && sawPlannerUpdate) {
              streamRequest.destroy();
              finish();
              return;
            }
          }
        });

        response.on("error", (error) => {
          if (!finished) {
            fail(error instanceof Error ? error : new Error(String(error)));
          }
        });

        response.on("end", () => {
          if (!finished && sawPlannerUpdate) {
            finish();
          } else if (!finished) {
            fail(new Error("Antigravity bridge stream ended before a response was produced."));
          }
        });

        sendUserMessage(credentials, conversationId, prompt, request.model).catch((error) => {
          streamRequest.destroy();
          fail(error instanceof Error ? error : new Error(String(error)));
        });
      },
    );

    streamRequest.on("error", (error) => {
      fail(error instanceof Error ? error : new Error(String(error)));
    });

    streamRequest.write(
      encodeConnectJsonFrame({
        conversationId,
        subscriberId: crypto.randomUUID(),
        trajectoryVerbosity: "CLIENT_TRAJECTORY_VERBOSITY_FULL",
      }),
    );
    streamRequest.end();
  });
}
