import * as crypto from "node:crypto";
import * as https from "node:https";

import { getAntigravityBridgeUserAgent, type AntigravityBridgeCredentials } from "./auth";
import { logBridgeDebug } from "./debug";
import { resolveAntigravityBridgeRequestedModel } from "./models";
import { buildFallbackPrompt, extractBridgeText, extractBridgeUserTurn } from "./user-turn";

export interface BridgeChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | Array<Record<string, unknown>>;
}

export interface BridgeChatCompletionRequest {
  model?: string;
  messages?: BridgeChatMessage[];
  disableKnowledge?: boolean;
  disableConversationHistory?: boolean;
}

export interface BridgeDelta {
  type: "text" | "reasoning";
  text: string;
}

export interface BridgeNativeToolCall {
  id?: string;
  name: string;
  arguments: unknown;
  rawArgumentsJson?: string;
}

export interface BridgePlannerUpdate {
  messageId?: string;
  response?: string;
  thinking?: string;
  status?: string;
  errorMessage?: string;
  stepTypes: string[];
  stepCount: number;
  latestStepCase?: string;
  latestStepStatus?: string;
  latestRequestedInteractionCase?: string;
  latestCommandLine?: string;
  latestTrajectoryId?: string;
  latestStepIndex?: number;
  nativeToolCalls: BridgeNativeToolCall[];
}

export interface BridgeTurnResult {
  text: string;
  reasoning: string;
  nativeToolCalls?: BridgeNativeToolCall[];
}

export interface BridgeSessionState {
  conversationId: string;
  workspaceUri: string;
  lastUsedAt: number;
  chain: Promise<void>;
}

export interface BridgeCascadeConfigOptions {
  disableKnowledge?: boolean;
  disableConversationHistory?: boolean;
  agenticMode?: boolean;
  enableEphemeralMessages?: boolean;
  autoExecutionPolicy?: string;
  artifactReviewMode?: string;
}

type ConnectFrame = {
  flags: number;
  payload: string;
};

type StreamHandlers = {
  onDelta?: (delta: BridgeDelta) => void;
  onPlannerUpdate?: (update: BridgePlannerUpdate) => { stop?: boolean } | void;
  sendOptions?: BridgeCascadeConfigOptions;
};

const DEFAULT_TURN_TIMEOUT_MS = 120_000;
const STREAM_CONTENT_TYPE = "application/connect+json";
const STREAM_PATH = "/exa.language_server_pb.LanguageServerService/StreamAgentStateUpdates";
const START_PATH = "/exa.language_server_pb.LanguageServerService/StartCascade";
const SEND_PATH = "/exa.language_server_pb.LanguageServerService/SendUserCascadeMessage";
const AUTO_EXECUTION_POLICY_EAGER = "CASCADE_COMMANDS_AUTO_EXECUTION_EAGER";
const ARTIFACT_REVIEW_MODE_TURBO = "ARTIFACT_REVIEW_MODE_TURBO";

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

export function buildBridgePrompt(request: BridgeChatCompletionRequest): string {
  const messages = request.messages ?? [];
  const reversedUser = [...messages].reverse().find((message) => message.role === "user");
  if (reversedUser) {
    return extractBridgeText(reversedUser.content);
  }

  return buildFallbackPrompt(messages);
}

export function buildBridgeCascadeConfig(
  requestedModel: string,
  options: BridgeCascadeConfigOptions = {},
): Record<string, unknown> {
  return {
    plannerConfig: {
      conversational: {
        plannerMode: "CONVERSATIONAL_PLANNER_MODE_DEFAULT",
        agenticMode: options.agenticMode ?? true,
      },
      toolConfig: {
        runCommand: {
          autoCommandConfig: {
            autoExecutionPolicy: options.autoExecutionPolicy ?? AUTO_EXECUTION_POLICY_EAGER,
          },
        },
        notifyUser: {
          artifactReviewMode: options.artifactReviewMode ?? ARTIFACT_REVIEW_MODE_TURBO,
        },
      },
      requestedModel: {
        model: requestedModel,
      },
      ephemeralMessagesConfig: {
        enabled: options.enableEphemeralMessages ?? true,
      },
      knowledgeConfig: {
        enabled: options.disableKnowledge ? false : true,
      },
    },
    conversationHistoryConfig: {
      enabled: options.disableConversationHistory ? false : true,
    },
  };
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

export function extractPlannerUpdate(update: any): BridgePlannerUpdate {
  const source = update?.update ?? update;
  const steps = source?.mainTrajectoryUpdate?.stepsUpdate?.steps;
  const plannerStep = Array.isArray(steps)
    ? [...steps]
        .reverse()
        .find((step) => step?.type === "CORTEX_STEP_TYPE_PLANNER_RESPONSE" && step?.plannerResponse)
    : undefined;

  const plannerResponse = plannerStep?.plannerResponse;
  const latestStep = Array.isArray(steps)
    ? [...steps]
      .reverse()
      .find((step) => extractNativeStepCase(step) || typeof step?.type === "string")
    : undefined;
  const errorMessage =
    source?.mainTrajectoryUpdate?.lastStepError?.message ??
    source?.lastStepError?.message;
  const sourceStepInfo = latestStep?.metadata?.sourceTrajectoryStepInfo;

  return {
    messageId: plannerResponse?.messageId,
    response: plannerResponse?.modifiedResponse ?? plannerResponse?.response,
    thinking: plannerResponse?.thinking,
    status: source?.status,
    errorMessage: errorMessage || undefined,
    stepTypes: Array.isArray(steps)
      ? steps
        .map((step) => (typeof step?.type === "string" ? step.type : "UNKNOWN_STEP"))
        .filter((type): type is string => Boolean(type))
      : [],
    stepCount: Array.isArray(steps) ? steps.length : 0,
    latestStepCase: extractNativeStepCase(latestStep),
    latestStepStatus: typeof latestStep?.status === "string" ? latestStep.status : undefined,
    latestRequestedInteractionCase: extractRequestedInteractionCase(latestStep),
    latestCommandLine: extractCommandLine(latestStep),
    latestTrajectoryId: typeof sourceStepInfo?.trajectoryId === "string" ? sourceStepInfo.trajectoryId : undefined,
    latestStepIndex: Number.isInteger(sourceStepInfo?.stepIndex) ? sourceStepInfo.stepIndex : undefined,
    nativeToolCalls: extractPlannerToolCalls(plannerResponse?.toolCalls),
  };
}

function parsePlannerToolArguments(value: unknown): unknown {
  if (typeof value !== "string") {
    return value ?? {};
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return {};
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function extractPlannerToolCalls(value: unknown): BridgeNativeToolCall[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || typeof entry.name !== "string") {
      return [];
    }

    return [
      {
        id: typeof entry.id === "string" ? entry.id : undefined,
        name: entry.name,
        arguments: parsePlannerToolArguments(entry.argumentsJson),
        rawArgumentsJson: typeof entry.argumentsJson === "string" ? entry.argumentsJson : undefined,
      },
    ];
  });
}

function extractNativeStepCase(step: any): string | undefined {
  if (!step || typeof step !== "object") {
    return undefined;
  }

  if (typeof step?.step?.case === "string") {
    return step.step.case;
  }

  const knownCases = [
    "plannerResponse",
    "runCommand",
    "commandStatus",
    "sendCommandInput",
    "readTerminal",
    "manageTask",
    "codeAction",
    "viewFile",
    "viewContentChunk",
    "listDirectory",
    "find",
    "grepSearch",
    "codeSearch",
    "internalSearch",
    "findAllReferences",
    "searchWeb",
    "readUrlContent",
    "browserSubagent",
    "openBrowserUrl",
    "executeBrowserJavascript",
    "userInput",
    "ephemeralMessage",
    "systemMessage",
    "generic",
    "checkpoint",
    "invokeSubagent",
  ];

  return knownCases.find((key) => step[key] !== undefined);
}

function extractRequestedInteractionCase(step: any): string | undefined {
  if (!step || typeof step !== "object") {
    return undefined;
  }

  if (typeof step?.requestedInteraction?.interaction?.case === "string") {
    return step.requestedInteraction.interaction.case;
  }

  if (typeof step?.requestedInteraction?.case === "string") {
    return step.requestedInteraction.case;
  }

  return undefined;
}

function extractCommandLine(step: any): string | undefined {
  if (!step || typeof step !== "object") {
    return undefined;
  }

  const value =
    step?.step?.value?.commandLine
    ?? step?.runCommand?.commandLine
    ?? step?.commandStatus?.commandLine
    ?? step?.sendCommandInput?.commandLine;

  return typeof value === "string" ? value : undefined;
}

export interface BridgePlannerUpdateGateState {
  sendStarted: boolean;
  sendCompleted: boolean;
  baselineMessageId?: string;
  activeMessageId?: string;
}

/**
 * Decide whether one planner update belongs to the current outbound turn.
 *
 * Params:
 * state: BridgePlannerUpdateGateState - Current stream gating state.
 * planner: { messageId?: string; status?: string } - Parsed planner update.
 *
 * Returns:
 * { accept: boolean; reason: string; nextBaselineMessageId?: string; nextActiveMessageId?: string } - Classification result.
 */
export function classifyPlannerUpdateForCurrentTurn(
  state: BridgePlannerUpdateGateState,
  planner: { messageId?: string; status?: string },
): { accept: boolean; reason: string; nextBaselineMessageId?: string; nextActiveMessageId?: string } {
  if (!state.sendStarted) {
    return {
      accept: false,
      reason: "capturing-baseline-before-send",
      nextBaselineMessageId: planner.messageId ?? state.baselineMessageId,
    };
  }

  if (state.activeMessageId) {
    if (!planner.messageId || planner.messageId === state.activeMessageId) {
      return {
        accept: true,
        reason: "active-turn-update",
      };
    }

    if (state.baselineMessageId && planner.messageId === state.baselineMessageId) {
      return {
        accept: false,
        reason: "stale-baseline-message",
      };
    }

    return {
      accept: true,
      reason: "switching-message-id",
      nextActiveMessageId: planner.messageId,
    };
  }

  if (!planner.messageId) {
    return {
      accept: false,
      reason: state.sendCompleted ? "waiting-for-first-message-id" : "waiting-for-send-ack",
    };
  }

  if (state.baselineMessageId && planner.messageId === state.baselineMessageId) {
    return {
      accept: false,
      reason: "stale-baseline-message",
    };
  }

  if (!state.sendCompleted && planner.status === "CASCADE_RUN_STATUS_IDLE") {
    return {
      accept: false,
      reason: "waiting-for-send-ack-idle-message",
    };
  }

  return {
    accept: true,
    reason: "new-message-id",
    nextActiveMessageId: planner.messageId,
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
  logBridgeDebug("bridge-start-cascade", {
    accountKey: credentials.accountKey?.slice(-8),
    processId: credentials.processId,
    port: credentials.port,
    workspaceUri,
  });
  const response = await postUnaryJson(credentials, START_PATH, {
    source: "CORTEX_TRAJECTORY_SOURCE_CASCADE_CLIENT",
    cascadeId: crypto.randomUUID(),
    workspaceUris: [workspaceUri],
  });
  logBridgeDebug("bridge-start-cascade-response", {
    accountKey: credentials.accountKey?.slice(-8),
    processId: credentials.processId,
    port: credentials.port,
    workspaceUri,
    status: response.status,
    bodyPreview: safePreview(response.body, 500),
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
  turn: {
    prompt: string;
    media: Array<{
      mimeType: string;
      inlineData: string;
    }>;
  },
  model: string | undefined,
  options?: BridgeCascadeConfigOptions,
): Promise<void> {
  const requestedModel = resolveAntigravityBridgeRequestedModel(model);
  logBridgeDebug("bridge-send-user-message", {
    accountKey: credentials.accountKey?.slice(-8),
    conversationId,
    requestedModel,
    promptLength: turn.prompt.length,
    promptPreview: safePreview(turn.prompt, 1200),
    mediaCount: turn.media.length,
    disableKnowledge: options?.disableKnowledge === true,
    disableConversationHistory: options?.disableConversationHistory === true,
    agenticMode: options?.agenticMode ?? true,
    enableEphemeralMessages: options?.enableEphemeralMessages ?? true,
    autoExecutionPolicy: options?.autoExecutionPolicy ?? AUTO_EXECUTION_POLICY_EAGER,
    artifactReviewMode: options?.artifactReviewMode ?? ARTIFACT_REVIEW_MODE_TURBO,
  });
  const response = await postUnaryJson(credentials, SEND_PATH, {
    cascadeId: conversationId,
    items: turn.prompt ? [{ text: turn.prompt }] : [],
    ...(turn.media.length > 0 ? { media: turn.media } : {}),
    cascadeConfig: buildBridgeCascadeConfig(requestedModel, options),
    clientType: "CHAT_CLIENT_REQUEST_STREAM_CLIENT_TYPE_IDE",
  });
  logBridgeDebug("bridge-send-user-message-response", {
    accountKey: credentials.accountKey?.slice(-8),
    conversationId,
    requestedModel,
    status: response.status,
    bodyPreview: safePreview(response.body, 500),
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
  const turn = await extractBridgeUserTurn(request);
  if (!turn.prompt && turn.media.length === 0) {
    throw new Error("Antigravity bridge could not find a user prompt or image attachment to send.");
  }

  logBridgeDebug("bridge-run-turn", {
    accountKey: credentials.accountKey?.slice(-8),
    conversationId,
    model: request.model || "antigravity-bridge",
    promptLength: turn.prompt.length,
    mediaCount: turn.media.length,
  });

  return new Promise<BridgeTurnResult>((resolve, reject) => {
    let responseText = "";
    let reasoningText = "";
    let nativeToolCalls: BridgeNativeToolCall[] = [];
    let activeMessageId: string | undefined;
    let baselineMessageId: string | undefined;
    let sawPlannerUpdate = false;
    let finished = false;
    let sendStarted = false;
    let sendCompleted = false;
    let frameCount = 0;
    let buffer: Buffer = Buffer.alloc(0) as Buffer;
    const turnId = crypto.randomUUID();

    const timeout = setTimeout(() => {
      if (finished) {
        return;
      }
      finished = true;
      logBridgeDebug("bridge-run-turn-timeout", {
        accountKey: credentials.accountKey?.slice(-8),
        conversationId,
        turnId,
        sendStarted,
        sendCompleted,
        baselineMessageId: baselineMessageId ?? null,
        activeMessageId: activeMessageId ?? null,
        sawPlannerUpdate,
        frameCount,
        timeoutMs: DEFAULT_TURN_TIMEOUT_MS,
      });
      reject(new Error("Timed out waiting for Antigravity bridge response."));
    }, DEFAULT_TURN_TIMEOUT_MS);

    const finish = () => {
      if (finished) {
        return;
      }
      finished = true;
      clearTimeout(timeout);
      logBridgeDebug("bridge-run-turn-finish", {
        accountKey: credentials.accountKey?.slice(-8),
        conversationId,
        turnId,
        sendStarted,
        sendCompleted,
        baselineMessageId: baselineMessageId ?? null,
        activeMessageId: activeMessageId ?? null,
        sawPlannerUpdate,
        frameCount,
        textLength: responseText.length,
        reasoningLength: reasoningText.length,
        nativeToolCallCount: nativeToolCalls.length,
      });
      resolve({
        text: responseText,
        reasoning: reasoningText,
        nativeToolCalls,
      });
    };

    const fail = (error: Error) => {
      if (finished) {
        return;
      }
      finished = true;
      clearTimeout(timeout);
      logBridgeDebug("bridge-run-turn-fail", {
        accountKey: credentials.accountKey?.slice(-8),
        conversationId,
        turnId,
        sendStarted,
        sendCompleted,
        baselineMessageId: baselineMessageId ?? null,
        activeMessageId: activeMessageId ?? null,
        sawPlannerUpdate,
        frameCount,
        error: error.message,
        nativeToolCallCount: nativeToolCalls.length,
      });
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
            frameCount += 1;
            let payload: any;
            try {
              payload = JSON.parse(frame.payload || "{}");
            } catch {
              logBridgeDebug("bridge-run-turn-frame-parse-failed", {
                accountKey: credentials.accountKey?.slice(-8),
                conversationId,
                turnId,
                frameCount,
                flags: frame.flags,
                payloadPreview: frame.payload.slice(0, 400),
              });
              continue;
            }

            logBridgeDebug("bridge-run-turn-frame-raw", {
              accountKey: credentials.accountKey?.slice(-8),
              conversationId,
              turnId,
              frameCount,
              flags: frame.flags,
              rawPayload: frame.payload,
            });

            if ((frame.flags & 0b10) !== 0) {
              logBridgeDebug("bridge-run-turn-frame-trailer", {
                accountKey: credentials.accountKey?.slice(-8),
                conversationId,
                turnId,
                frameCount,
                flags: frame.flags,
                payloadPreview: safePreview(frame.payload, 400),
              });
              if (payload?.error?.message) {
                fail(new Error(payload.error.message));
                return;
              }
              continue;
            }

            const planner = extractPlannerUpdate(payload.update);
            const classification = classifyPlannerUpdateForCurrentTurn(
              {
                sendStarted,
                sendCompleted,
                baselineMessageId,
                activeMessageId,
              },
              planner,
            );
            if (!baselineMessageId && classification.nextBaselineMessageId) {
              baselineMessageId = classification.nextBaselineMessageId;
            }
            if (!activeMessageId && classification.nextActiveMessageId) {
              activeMessageId = classification.nextActiveMessageId;
            }
            logBridgeDebug("bridge-run-turn-frame", {
              accountKey: credentials.accountKey?.slice(-8),
              conversationId,
              turnId,
              frameCount,
              flags: frame.flags,
              sendStarted,
              sendCompleted,
              baselineMessageId: baselineMessageId ?? null,
              activeMessageId: activeMessageId ?? null,
              plannerMessageId: planner.messageId ?? null,
              plannerStatus: planner.status ?? null,
              plannerError: planner.errorMessage ?? null,
              stepCount: planner.stepCount,
              stepTypes: planner.stepTypes,
              latestStepCase: planner.latestStepCase ?? null,
              latestStepStatus: planner.latestStepStatus ?? null,
              latestRequestedInteractionCase: planner.latestRequestedInteractionCase ?? null,
              latestCommandLine: planner.latestCommandLine ?? null,
              latestTrajectoryId: planner.latestTrajectoryId ?? null,
              latestStepIndex: planner.latestStepIndex ?? null,
              responseLength: planner.response?.length ?? 0,
              responsePreview: safePreview(planner.response, 300),
              thinkingLength: planner.thinking?.length ?? 0,
              thinkingPreview: safePreview(planner.thinking, 300),
              accept: classification.accept,
              acceptReason: classification.reason,
            });
            if (planner.errorMessage) {
              fail(new Error(planner.errorMessage));
              return;
            }

            if (!classification.accept) {
              continue;
            }

            if (planner.nativeToolCalls.length > 0) {
              nativeToolCalls = planner.nativeToolCalls;
            }

            if (planner.thinking || planner.response || planner.nativeToolCalls.length > 0) {
              sawPlannerUpdate = true;
              reasoningText = emitDiff("reasoning", planner.thinking, reasoningText, handlers.onDelta);
              responseText = emitDiff("text", planner.response, responseText, handlers.onDelta);
            }

            const plannerAction = handlers.onPlannerUpdate?.(planner);
            if (plannerAction?.stop) {
              logBridgeDebug("bridge-run-turn-stop-requested", {
                accountKey: credentials.accountKey?.slice(-8),
                conversationId,
                turnId,
                frameCount,
                plannerMessageId: planner.messageId ?? null,
                latestStepCase: planner.latestStepCase ?? null,
                nativeToolCallCount: nativeToolCalls.length,
              });
              finish();
              streamRequest.destroy();
              return;
            }

            if (planner.status === "CASCADE_RUN_STATUS_IDLE" && sawPlannerUpdate && sendStarted) {
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
            logBridgeDebug("bridge-run-turn-ended-without-update", {
              accountKey: credentials.accountKey?.slice(-8),
              conversationId,
              turnId,
              sendStarted,
              sendCompleted,
              baselineMessageId: baselineMessageId ?? null,
              activeMessageId: activeMessageId ?? null,
              frameCount,
            });
            fail(new Error("Antigravity bridge stream ended before a response was produced."));
          }
        });

        sendStarted = true;
        logBridgeDebug("bridge-run-turn-send-start", {
          accountKey: credentials.accountKey?.slice(-8),
          conversationId,
          turnId,
          baselineMessageId: baselineMessageId ?? null,
          model: request.model || "antigravity-bridge",
        });
        sendUserMessage(credentials, conversationId, turn, request.model, {
          disableKnowledge: request.disableKnowledge,
          disableConversationHistory: request.disableConversationHistory,
          ...handlers.sendOptions,
        })
          .then(() => {
            sendCompleted = true;
            logBridgeDebug("bridge-run-turn-send-complete", {
              accountKey: credentials.accountKey?.slice(-8),
              conversationId,
              turnId,
              baselineMessageId: baselineMessageId ?? null,
              activeMessageId: activeMessageId ?? null,
            });
          })
          .catch((error) => {
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

/**
 * Create a bounded preview string for debug logging.
 *
 * Params:
 * value: string | undefined - Source string.
 * limit: number - Maximum number of characters to keep.
 *
 * Returns:
 * string | undefined - Bounded preview when input is present.
 */
function safePreview(value: string | undefined, limit: number): string | undefined {
  if (!value) {
    return undefined;
  }

  return value.length <= limit ? value : `${value.slice(0, limit)}...`;
}
