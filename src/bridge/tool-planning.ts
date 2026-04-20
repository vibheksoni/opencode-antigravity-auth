import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import type { AntigravityBridgeCredentials } from "./auth";
import { logBridgeDebug } from "./debug";
import {
  runBridgeTurn,
  startBridgeConversation,
  type BridgeCascadeConfigOptions,
  type BridgeChatCompletionRequest,
  type BridgeChatMessage,
  type BridgeNativeToolCall,
  type BridgePlannerUpdate,
} from "./connect";

export interface BridgeChatToolDefinition {
  type?: string;
  function?: {
    name?: string;
    description?: string;
    parameters?: unknown;
  };
}

export interface BridgeToolPlanningRequest extends BridgeChatCompletionRequest {
  messages?: BridgeChatMessage[];
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
  tools?: BridgeChatToolDefinition[];
  providerOptions?: Record<string, unknown>;
}

export type BridgeToolCall = {
  name: string;
  arguments: unknown;
};

export type BridgeToolCallPlan =
  | { action: "final"; content: string }
  | { action: "tool_call"; tool_calls: BridgeToolCall[] };

export type BridgeToolPlanningResult = {
  plan: BridgeToolCallPlan | null;
  content: string;
  reasoning: string;
  model: string;
};

export interface BridgeToolPlanningState {
  planningConversationId?: string;
}

const DEFAULT_TOOL_PLANNING_MODEL = "antigravity-bridge-gemini-3.1-pro-low";
const MAX_TOOL_REPAIR_ATTEMPTS = 2;
const MAX_PROMPT_CONVERSATION_LINES = 18;
const MAX_PROMPT_CONVERSATION_CHARS = 1600;
const MAX_TOOL_SCHEMA_PROPERTIES = 8;
const MAX_TOOL_ENUM_VALUES = 4;
const PLANNER_SEND_OPTIONS: BridgeCascadeConfigOptions = {
  agenticMode: false,
  enableEphemeralMessages: false,
};

type BridgeNativeToolAlias = {
  aliasName: string;
  targetTool: string;
  description: string;
  schema: Record<string, unknown>;
};

const NATIVE_TOOL_ALIAS_CATALOG: BridgeNativeToolAlias[] = [
  {
    aliasName: "runInTerminal",
    targetTool: "bash",
    description: "Native Antigravity terminal execution alias.",
    schema: {
      type: "object",
      properties: {
        command: { type: "string", description: "The command to run in the terminal." },
        explanation: {
          type: "string",
          description: "A one-sentence description of what the command does.",
        },
        isBackground: {
          type: "boolean",
          description: "Whether the command starts a background process.",
        },
      },
      required: ["command", "explanation", "isBackground"],
    },
  },
  {
    aliasName: "readFile",
    targetTool: "read",
    description: "Native Antigravity file-read alias.",
    schema: {
      type: "object",
      properties: {
        filePath: { type: "string", description: "Absolute path of the file to read." },
      },
      required: ["filePath"],
    },
  },
  {
    aliasName: "viewFile",
    targetTool: "read",
    description: "Native Antigravity file-view alias.",
    schema: {
      type: "object",
      properties: {
        filePath: { type: "string", description: "Absolute path of the file to inspect." },
      },
      required: ["filePath"],
    },
  },
  {
    aliasName: "writeToFile",
    targetTool: "write",
    description: "Native Antigravity write-file alias.",
    schema: {
      type: "object",
      properties: {
        filePath: { type: "string", description: "Absolute path of the file to create or replace." },
        content: { type: "string", description: "Full file contents." },
      },
      required: ["filePath", "content"],
    },
  },
  {
    aliasName: "listDirectory",
    targetTool: "bash",
    description: "Native Antigravity directory-list alias.",
    schema: {
      type: "object",
      properties: {
        directoryPathUri: { type: "string", description: "Absolute directory path to enumerate." },
        recursive: { type: "boolean", description: "Whether to recurse into subdirectories." },
      },
      required: ["directoryPathUri"],
    },
  },
  {
    aliasName: "find",
    targetTool: "glob",
    description: "Native Antigravity file-discovery alias.",
    schema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Glob-style file pattern to match." },
        directoryPathUri: { type: "string", description: "Optional absolute directory scope." },
      },
      required: ["pattern"],
    },
  },
  {
    aliasName: "findFiles",
    targetTool: "glob",
    description: "Native Antigravity file-search alias.",
    schema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Glob-style file pattern to match." },
        directoryPathUri: { type: "string", description: "Optional absolute directory scope." },
      },
      required: ["pattern"],
    },
  },
  {
    aliasName: "grepSearch",
    targetTool: "grep",
    description: "Native Antigravity text-search alias.",
    schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search text or regex." },
        directoryPathUri: { type: "string", description: "Optional absolute directory scope." },
      },
      required: ["query"],
    },
  },
  {
    aliasName: "codeSearch",
    targetTool: "grep",
    description: "Native Antigravity code-search alias.",
    schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search text or regex." },
        directoryPathUri: { type: "string", description: "Optional absolute directory scope." },
      },
      required: ["query"],
    },
  },
  {
    aliasName: "internalSearch",
    targetTool: "grep",
    description: "Native Antigravity internal-search alias.",
    schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search text or regex." },
        directoryPathUri: { type: "string", description: "Optional absolute directory scope." },
      },
      required: ["query"],
    },
  },
  {
    aliasName: "searchWeb",
    targetTool: "google_search",
    description: "Native Antigravity web-search alias.",
    schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Web search query." },
      },
      required: ["query"],
    },
  },
  {
    aliasName: "readUrlContent",
    targetTool: "webfetch",
    description: "Native Antigravity URL-read alias.",
    schema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Absolute URL to fetch." },
      },
      required: ["url"],
    },
  },
];

/**
 * Checks whether a bridge request should use prompt-based tool planning.
 *
 * Params:
 * request: BridgeToolPlanningRequest - Incoming OpenAI-compatible chat-completions request.
 *
 * Returns:
 * boolean - True when tools or prior tool messages are present.
 */
export function requestUsesToolPlanning(request: BridgeToolPlanningRequest): boolean {
  const hasToolsField = Array.isArray(request.tools) && request.tools.length > 0;
  const hasToolMessages = request.messages?.some(
    (message) =>
      message.role === "tool" ||
      (message.role === "assistant" &&
        Array.isArray((message as unknown as Record<string, unknown>).tool_calls) &&
        ((message as unknown as Record<string, unknown>).tool_calls as unknown[]).length > 0),
  );

  return Boolean(hasToolsField || hasToolMessages);
}

/**
 * Builds a prompt that asks the model to return visible tool transcript records.
 *
 * Params:
 * request: BridgeToolPlanningRequest - Chat request with tool definitions and message history.
 *
 * Returns:
 * string - Synthetic planning prompt for the model.
 */
export function buildToolPrompt(request: BridgeToolPlanningRequest, workspaceDirectory?: string): string {
  const tools = Array.isArray(request.tools) ? request.tools : [];
  const availableTools = new Set(
    tools.map((tool) => tool.function?.name).filter((name): name is string => Boolean(name)),
  );
  const toolList = tools.length > 0 ? tools.map(summarizeTool).join("\n") : "(none)";
  const toolExamples = tools.length > 0 ? tools.map(buildToolExampleRecord).join("\n") : '{"action":"tool_call","tool_calls":[{"name":"tool_name","arguments":{"arg":"value"}}]}';
  const nativeAliasList = buildNativeAliasPromptSection(availableTools);
  const nativeAliasExamples = buildNativeAliasExampleSection(availableTools);
  const scopedDirectory = extractConversationScopeDirectory(request, workspaceDirectory);
  const hasSystemMessages = (request.messages ?? []).some((message) => message.role === "system");

  const conversationLines: string[] = [];
  for (const message of request.messages ?? []) {
    const role = message.role || "user";
    if (role === "system") {
      continue;
    }

    if (role === "tool") {
      const content = extractTextParts(message.content);
      const record = message as unknown as Record<string, unknown>;
      const name = typeof record.name === "string" ? record.name : "tool";
      const toolCallId = typeof record.tool_call_id === "string" ? record.tool_call_id : undefined;
      conversationLines.push(
        `TOOL RESULT (${name}${toolCallId ? `, id=${toolCallId}` : ""}): ${truncatePlannerConversationText(content)}`,
      );
      continue;
    }

    if (role === "assistant") {
      const record = message as unknown as Record<string, unknown>;
      if (Array.isArray(record.tool_calls) && record.tool_calls.length > 0) {
        conversationLines.push(
          `ASSISTANT TOOL_CALLS: ${truncatePlannerConversationText(JSON.stringify(record.tool_calls))}`,
        );
        continue;
      }
    }

    const content = extractTextParts(message.content);
    if (content) {
      conversationLines.push(`${role.toUpperCase()}: ${truncatePlannerConversationText(content)}`);
    }
  }
  const boundedConversationLines = boundPlannerConversationLines(conversationLines);

  return [
    "You are a tool-calling assistant running inside OpenCode.",
    "Environment: Windows PowerShell.",
    workspaceDirectory ? `Workspace directory: ${workspaceDirectory}` : undefined,
    scopedDirectory && scopedDirectory !== workspaceDirectory ? `Referenced directory scope: ${scopedDirectory}` : undefined,
    "",
    "Tool Planning Contract:",
    "- Prefer JSON output for tool planning and final answers.",
    "- Use plain JSON with no Markdown fences or wrapper prose.",
    "- The runtime may perform native or internal tool behavior, but your output must still be machine-parseable.",
    "- Legacy transcript records are accepted only as a fallback if JSON repeatedly fails.",
    hasSystemMessages
      ? "- Background OpenCode system instructions are already in force. Do not answer or summarize them here. If any background rule only asks for acknowledgement, confirmation, or waiting for a command, treat that as already satisfied and continue with the actual task."
      : undefined,
    "",
    "Available tools:",
    "- The tools below are the exact live OpenCode tools available for this turn.",
    "- If a tool is not listed below, you do not have access to it in this turn.",
    "- Each tool includes its exact runtime parameter schema. Follow that schema literally.",
    toolList,
    nativeAliasList ? "" : undefined,
    nativeAliasList ? "Native compatibility aliases:" : undefined,
    nativeAliasList ? "- The aliases below mirror Antigravity's native tool vocabulary and will be translated to the live OpenCode tools for this turn." : undefined,
    nativeAliasList ? "- You may use either the exact OpenCode tool name or one of these compatibility aliases." : undefined,
    nativeAliasList || undefined,
    "",
    "Preferred output grammar:",
    "- If a higher-priority workspace rule requires a fixed leading header, output that exact header line first.",
    "- After that optional fixed header, output only one JSON object and nothing else.",
    "- Do not add narration, explanations, status lines, XML, Markdown fences, or wrapper prose outside the JSON.",
    "- NEVER invent tool names. Use one of the exact tool names from Available tools or Native compatibility aliases.",
    "- MCP tools are normal tools here. Use their exact provided names if you need them.",
    "- If you need to ask the user something, use the `question` tool, not `ask_user_question`.",
    "- If you need terminal execution, use the exact terminal-capable tool from the available list and keep commands Windows-friendly.",
    "- On Windows, do not emit Unix-only command forms when a Windows-native equivalent is expected.",
    "- Infer the correct next tool from the live tool schemas and the user request. Do not wait for the prompt to name a specific tool for you.",
    "- If the user explicitly points at a directory or file using @path, a relative path, or an absolute path, treat that as the target scope.",
    "- If the user later says `that folder`, `there`, or `in that directory`, prefer the latest referenced directory scope.",
    "- When a request implies a durable side effect, a prose summary is not a completed result. Return a tool_call that performs the side effect using an available tool.",
    "- When the request targets a referenced directory scope, ensure the tool arguments point into that scope explicitly.",
    "- Avoid extra discovery once the target is already unambiguous from the conversation or prior tool results.",
    "- Match tool arguments to the real target type. If the target is a directory, use a directory-capable tool; if it is a file, use a file-capable tool.",
    "- Never repeat an identical tool call when that exact tool result is already present in the conversation. Use the result to pick the next tool or produce the final answer.",
    "- After the required tool results are already present, stop planning and produce the final answer instead of calling extra tools.",
    "- Arguments MUST follow each tool's JSON schema exactly (types, nesting, required fields).",
    "",
    "Preferred JSON records:",
    '{"action":"tool_call","tool_calls":[{"name":"tool_name","arguments":{"arg":"value"}}]}',
    '{"action":"final","content":"your user-visible reply here"}',
    "",
    "Legacy fallback records:",
    "CALL:::{\"name\":\"tool_name\",\"arguments\":{\"arg\":\"value\"}}",
    "RESPONSE:::your user-visible reply here",
    "DONE:::",
    "",
    "Decision rules:",
    "- If one or more tools are needed, output a single JSON tool_call plan and nothing else after the optional fixed header.",
    "- If tool results are already present in the conversation and the answer is ready, output a single JSON final record.",
    "- Do not replace the records with prose like `Listed directory` or `I will inspect the files`.",
    "- Do not emit XML tags.",
    "- Do not use CALL::: / RESPONSE::: / DONE::: unless JSON output fails repeatedly.",
    "",
    "Examples for current tools:",
    toolExamples,
    nativeAliasExamples ? "Native alias examples:" : undefined,
    nativeAliasExamples || undefined,
    '{"action":"final","content":"The current directory contains:\\n- src/\\n- tests/\\n- package.json"}',
    "",
    "Conversation:",
    boundedConversationLines.join("\n\n"),
  ]
    .filter(Boolean)
    .join("\n");
}

function truncatePlannerConversationText(value: string): string {
  const normalized = value.trim();
  if (!normalized) {
    return normalized;
  }

  if (normalized.length <= MAX_PROMPT_CONVERSATION_CHARS) {
    return normalized;
  }

  return `${normalized.slice(0, MAX_PROMPT_CONVERSATION_CHARS)}\n...[truncated ${normalized.length - MAX_PROMPT_CONVERSATION_CHARS} chars]`;
}

function boundPlannerConversationLines(lines: string[]): string[] {
  if (lines.length <= MAX_PROMPT_CONVERSATION_LINES) {
    return lines;
  }

  return [
    `[${lines.length - MAX_PROMPT_CONVERSATION_LINES} earlier conversation records omitted]`,
    ...lines.slice(-MAX_PROMPT_CONVERSATION_LINES),
  ];
}

/**
 * Builds a repair prompt for planner outputs that failed the structured parser.
 *
 * Params:
 * request: BridgeToolPlanningRequest - Original tool planning request.
 * invalidOutput: string - Raw invalid model output from the first planning pass.
 *
 * Returns:
 * string - Follow-up prompt requesting one valid visible transcript.
 */
function buildToolRepairPrompt(
  request: BridgeToolPlanningRequest,
  invalidOutput: string,
  workspaceDirectory?: string,
  validationReason?: string,
): string {
  return [
    buildToolPrompt(request, workspaceDirectory),
    "",
    "Your previous output was invalid because it did not follow the required structured output format.",
    validationReason ? `Additional planner correction: ${validationReason}` : undefined,
    "Return the same intent again using the preferred JSON format after any required fixed header line.",
    "",
    "Invalid output:",
    invalidOutput,
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Plans the next tool action by sending a synthetic planning prompt through Antigravity.
 *
 * Params:
 * credentials: AntigravityBridgeCredentials - Live local bridge credentials.
 * workspaceUri: string - Active workspace URI for the planning conversation.
 * request: BridgeToolPlanningRequest - OpenAI-style tool call request.
 *
 * Returns:
 * Promise<BridgeToolPlanningResult> - Parsed tool plan plus raw text/reasoning.
 */
export async function planBridgeToolCall(
  credentials: AntigravityBridgeCredentials,
  workspaceUri: string,
  request: BridgeToolPlanningRequest,
  planningState?: BridgeToolPlanningState,
): Promise<BridgeToolPlanningResult> {
  const workspaceDirectory = workspaceDirectoryFromUri(workspaceUri);
  const conversationId = await getOrCreatePlanningConversation(credentials, workspaceUri, planningState);
  const model = request.model?.startsWith("antigravity-bridge-gemini-")
    ? request.model
    : DEFAULT_TOOL_PLANNING_MODEL;
  const prompt = buildToolPrompt(request, workspaceDirectory);
  logBridgeDebug("bridge-tool-plan-start", {
    accountKey: credentials.accountKey?.slice(-8),
    model,
    requestedModel: request.model || "antigravity-bridge",
    conversationId,
    workspaceDirectory: workspaceDirectory ?? null,
    messageCount: Array.isArray(request.messages) ? request.messages.length : 0,
    toolCount: Array.isArray(request.tools) ? request.tools.length : 0,
    promptLength: prompt.length,
    promptPreview: prompt.slice(0, 1200),
  });
  let reply = await runBridgeTurn(credentials, conversationId, {
    model,
    messages: [{ role: "user", content: prompt }],
    disableKnowledge: true,
    disableConversationHistory: true,
  }, {
    sendOptions: PLANNER_SEND_OPTIONS,
    onPlannerUpdate: (planner) => {
      const earlyPlan = deriveEarlyPlannerToolPlan(request, planner, workspaceDirectory);
      if (earlyPlan) {
        return { stop: true };
      }
      return undefined;
    },
  });
  let { plan: parsedPlan, validationReason, recovered, source } = selectPreferredPlannerToolPlan(
    request,
    reply.text,
    reply.nativeToolCalls,
    workspaceDirectory,
  );
  logBridgeDebug("bridge-tool-plan-attempt", {
    accountKey: credentials.accountKey?.slice(-8),
    model,
    attempt: 0,
    parsedPlan: summarizeToolPlanForLog(parsedPlan),
    validationReason: validationReason ?? null,
    recoveredWrite: recovered,
    selectedSource: source,
    nativeToolCallCount: reply.nativeToolCalls?.length ?? 0,
    textLength: reply.text.length,
    reasoningLength: reply.reasoning.length,
    textPreview: reply.text.slice(0, 600),
  });
  let repaired = false;

  for (let attempt = 0; attempt < MAX_TOOL_REPAIR_ATTEMPTS && (!parsedPlan || validationReason) && reply.text.trim(); attempt += 1) {
    repaired = true;
    logBridgeDebug("bridge-tool-plan-repair-attempt", {
      accountKey: credentials.accountKey?.slice(-8),
      model,
      attempt: attempt + 1,
      invalidPreview: reply.text.slice(0, 300),
      validationReason: validationReason ?? null,
    });
    reply = await runBridgeTurn(credentials, conversationId, {
      model,
      messages: [
        {
          role: "user",
          content: buildToolRepairPrompt(request, reply.text, workspaceDirectory, validationReason),
        },
      ],
      disableKnowledge: true,
      disableConversationHistory: true,
    }, {
      sendOptions: PLANNER_SEND_OPTIONS,
      onPlannerUpdate: (planner) => {
        const earlyPlan = deriveEarlyPlannerToolPlan(request, planner, workspaceDirectory);
        if (earlyPlan) {
          return { stop: true };
        }
        return undefined;
      },
    });
    ({ plan: parsedPlan, validationReason, recovered, source } = selectPreferredPlannerToolPlan(
      request,
      reply.text,
      reply.nativeToolCalls,
      workspaceDirectory,
    ));
    logBridgeDebug("bridge-tool-plan-attempt", {
      accountKey: credentials.accountKey?.slice(-8),
      model,
      attempt: attempt + 1,
      parsedPlan: summarizeToolPlanForLog(parsedPlan),
      validationReason: validationReason ?? null,
      recoveredWrite: recovered,
      selectedSource: source,
      nativeToolCallCount: reply.nativeToolCalls?.length ?? 0,
      textLength: reply.text.length,
      reasoningLength: reply.reasoning.length,
      textPreview: reply.text.slice(0, 600),
    });
  }

  if (validationReason) {
    logBridgeDebug("bridge-tool-plan-invalid", {
      accountKey: credentials.accountKey?.slice(-8),
      model,
      requestedModel: request.model || "antigravity-bridge",
      conversationId,
      parsedPlan: summarizeToolPlanForLog(parsedPlan),
      validationReason,
      textPreview: reply.text.slice(0, 600),
    });
    throw new Error(validationReason);
  }

  if (!parsedPlan && looksLikeStructuredPlannerOutput(reply.text)) {
    throw new Error(validationReason ?? "Antigravity bridge planner returned invalid structured output.");
  }

  logBridgeDebug("bridge-tool-plan-result", {
    accountKey: credentials.accountKey?.slice(-8),
    model,
    requestedModel: request.model || "antigravity-bridge",
    repaired,
    textLength: reply.text.length,
    reasoningLength: reply.reasoning.length,
    parsedAction: parsedPlan?.action ?? null,
    parsedPlan: summarizeToolPlanForLog(parsedPlan),
    validationReason: validationReason ?? null,
    textPreview: reply.text.slice(0, 300),
  });

  return {
    plan: parsedPlan,
    content: reply.text,
    reasoning: reply.reasoning,
    model,
  };
}

/**
 * Creates a non-streaming OpenAI-style tool-planning response.
 *
 * Params:
 * credentials: AntigravityBridgeCredentials - Live local bridge credentials.
 * workspaceUri: string - Active workspace URI.
 * request: BridgeToolPlanningRequest - Incoming tool-capable request.
 *
 * Returns:
 * Promise<Response> - OpenAI-compatible response with `tool_calls` or final content.
 */
export async function handleBridgeToolPlanning(
  credentials: AntigravityBridgeCredentials,
  workspaceUri: string,
  request: BridgeToolPlanningRequest,
  planningState?: BridgeToolPlanningState,
): Promise<Response> {
  const { plan, content, model } = await planBridgeToolCall(credentials, workspaceUri, request, planningState);

  if (plan?.action === "tool_call") {
    return new Response(JSON.stringify(buildToolCallPayload(model, plan.tool_calls)), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }

  const finalContent = plan?.action === "final" ? plan.content : content;
  return new Response(
    JSON.stringify({
      id: `antigravity-tools-${Date.now()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: finalContent,
          },
          finish_reason: "stop",
        },
      ],
    }),
    {
      status: 200,
      headers: { "content-type": "application/json" },
    },
  );
}

/**
 * Creates a streaming OpenAI-compatible tool-planning response.
 *
 * Params:
 * credentials: AntigravityBridgeCredentials - Live local bridge credentials.
 * workspaceUri: string - Active workspace URI.
 * request: BridgeToolPlanningRequest - Incoming tool-capable request.
 *
 * Returns:
 * ReadableStream<Uint8Array> - SSE stream that emits either `tool_calls` or final content.
 */
export function handleBridgeToolPlanningStream(
  credentials: AntigravityBridgeCredentials,
  workspaceUri: string,
  request: BridgeToolPlanningRequest,
  planningState?: BridgeToolPlanningState,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const closeStream = () => {
        if (closed) {
          return;
        }
        closed = true;
        controller.close();
      };

      const enqueueDone = () => {
        if (closed) {
          return;
        }
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        closeStream();
      };

      const enqueueError = (message: string) => {
        if (closed) {
          return;
        }
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: { message } })}\n\n`));
        enqueueDone();
      };

      try {
        const workspaceDirectory = workspaceDirectoryFromUri(workspaceUri);
        const conversationId = await startBridgeConversation(credentials, workspaceUri);
        const model = request.model?.startsWith("antigravity-bridge-gemini-")
          ? request.model
          : DEFAULT_TOOL_PLANNING_MODEL;
        const prompt = buildToolPrompt(request, workspaceDirectory);
        const id = `antigravity-tools-${Date.now()}`;
        const created = Math.floor(Date.now() / 1000);
        let emittedToolCall = false;
        let emittedReasoningChars = 0;
        let resolveEarlyToolPlan: ((plan: Extract<BridgeToolCallPlan, { action: "tool_call" }> | null) => void) | undefined;
        const earlyToolPlanPromise = new Promise<Extract<BridgeToolCallPlan, { action: "tool_call" }> | null>((resolve) => {
          resolveEarlyToolPlan = resolve;
        });

        const enqueueReasoningDelta = (text: string) => {
          if (closed || !text) {
            return;
          }

          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({
                id,
                object: "chat.completion.chunk",
                created,
                model,
                choices: [
                  {
                    index: 0,
                    delta: { reasoning_text: text },
                    finish_reason: null,
                  },
                ],
              })}\n\n`,
            ),
          );
        };

        const enqueueToolCallAndFinish = (plan: Extract<BridgeToolCallPlan, { action: "tool_call" }>) => {
          if (closed) {
            return;
          }

          const mapped = mapToolCallsForStream(plan.tool_calls);
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({
                id,
                object: "chat.completion.chunk",
                created,
                model,
                choices: [
                  {
                    index: 0,
                    delta: {
                      role: "assistant",
                      tool_calls: mapped,
                    },
                    finish_reason: "tool_calls",
                  },
                ],
              })}\n\n`,
            ),
          );
          logBridgeDebug("bridge-tool-plan-stream-emit", {
            accountKey: credentials.accountKey?.slice(-8),
            model,
            conversationId,
            parsedPlan: summarizeToolPlanForLog(plan),
          });
          enqueueDone();
        };

        logBridgeDebug("bridge-tool-plan-stream-start", {
          accountKey: credentials.accountKey?.slice(-8),
          model,
          requestedModel: request.model || "antigravity-bridge",
          conversationId,
          workspaceDirectory: workspaceDirectory ?? null,
          messageCount: Array.isArray(request.messages) ? request.messages.length : 0,
          toolCount: Array.isArray(request.tools) ? request.tools.length : 0,
          promptLength: prompt.length,
          promptPreview: prompt.slice(0, 1200),
        });

        const planningPromise = runBridgeTurn(
          credentials,
          conversationId,
          {
            model,
            messages: [{ role: "user", content: prompt }],
            disableKnowledge: true,
            disableConversationHistory: true,
          },
          {
            sendOptions: PLANNER_SEND_OPTIONS,
            onDelta: (delta) => {
              if (delta.type === "reasoning") {
                emittedReasoningChars += delta.text.length;
                enqueueReasoningDelta(delta.text);
                return;
              }

              if (emittedToolCall) {
                return;
              }
            },
            onPlannerUpdate: (planner) => {
              if (emittedToolCall) {
                return undefined;
              }

              const earlyPlan = deriveEarlyPlannerToolPlan(request, planner, workspaceDirectory);
              if (!earlyPlan) {
                return undefined;
              }

              emittedToolCall = true;
              resolveEarlyToolPlan?.(earlyPlan);
              return { stop: true };
            },
          },
        );

        const earlyToolPlan = await Promise.race([
          earlyToolPlanPromise,
          planningPromise.then(() => null),
        ]);

        if (earlyToolPlan) {
          enqueueToolCallAndFinish(earlyToolPlan);
          void planningPromise.catch((error) => {
            logBridgeDebug("bridge-tool-plan-stream-background-error", {
              accountKey: credentials.accountKey?.slice(-8),
              model,
              conversationId,
              error: error instanceof Error ? error.message : String(error),
            });
          });
          return;
        }

        const reply = await planningPromise;
        if (closed) {
          return;
        }

        let { plan, validationReason, recovered, source } = selectPreferredPlannerToolPlan(
          request,
          reply.text,
          reply.nativeToolCalls,
          workspaceDirectory,
        );
        logBridgeDebug("bridge-tool-plan-stream-attempt", {
          accountKey: credentials.accountKey?.slice(-8),
          model,
          attempt: 0,
          parsedPlan: summarizeToolPlanForLog(plan),
          validationReason: validationReason ?? null,
          recoveredWrite: recovered,
          selectedSource: source,
          nativeToolCallCount: reply.nativeToolCalls?.length ?? 0,
          textLength: reply.text.length,
          reasoningLength: reply.reasoning.length,
          streamedReasoningLength: emittedReasoningChars,
          textPreview: reply.text.slice(0, 600),
        });

        let repaired = false;
        let currentReply = reply;
        for (let attempt = 0; attempt < MAX_TOOL_REPAIR_ATTEMPTS && (!plan || validationReason) && currentReply.text.trim(); attempt += 1) {
          repaired = true;
          logBridgeDebug("bridge-tool-plan-stream-repair-attempt", {
            accountKey: credentials.accountKey?.slice(-8),
            model,
            attempt: attempt + 1,
            invalidPreview: currentReply.text.slice(0, 300),
            validationReason: validationReason ?? null,
          });
          currentReply = await runBridgeTurn(credentials, conversationId, {
            model,
            messages: [
              {
                role: "user",
                content: buildToolRepairPrompt(request, currentReply.text, workspaceDirectory, validationReason),
              },
            ],
            disableKnowledge: true,
            disableConversationHistory: true,
          }, {
            sendOptions: PLANNER_SEND_OPTIONS,
            onPlannerUpdate: (planner) => {
              const earlyPlan = deriveEarlyPlannerToolPlan(request, planner, workspaceDirectory);
              if (earlyPlan) {
                return { stop: true };
              }
              return undefined;
            },
          });
          ({ plan, validationReason, recovered, source } = selectPreferredPlannerToolPlan(
            request,
            currentReply.text,
            currentReply.nativeToolCalls,
            workspaceDirectory,
          ));
          logBridgeDebug("bridge-tool-plan-stream-attempt", {
            accountKey: credentials.accountKey?.slice(-8),
            model,
            attempt: attempt + 1,
            parsedPlan: summarizeToolPlanForLog(plan),
            validationReason: validationReason ?? null,
            recoveredWrite: recovered,
            selectedSource: source,
            nativeToolCallCount: currentReply.nativeToolCalls?.length ?? 0,
            textLength: currentReply.text.length,
            reasoningLength: currentReply.reasoning.length,
            textPreview: currentReply.text.slice(0, 600),
          });
        }

        if (validationReason) {
          enqueueError(validationReason);
          return;
        }

        if (plan?.action === "tool_call") {
          enqueueToolCallAndFinish(plan);
          return;
        }

        const finalContent = plan?.action === "final" ? plan.content : currentReply.text;
        if (!finalContent.trim()) {
          enqueueError("Antigravity bridge planner returned an empty final response.");
          return;
        }
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({
              id,
              object: "chat.completion.chunk",
              created,
              model,
              choices: [
                {
                  index: 0,
                  delta: { content: finalContent },
                  finish_reason: "stop",
                },
              ],
            })}\n\n`,
          ),
        );
        logBridgeDebug("bridge-tool-plan-stream-result", {
          accountKey: credentials.accountKey?.slice(-8),
          model,
          requestedModel: request.model || "antigravity-bridge",
          conversationId,
          repaired,
          parsedPlan: summarizeToolPlanForLog(plan),
          validationReason: validationReason ?? null,
          finalContentLength: finalContent.length,
        });
        enqueueDone();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        enqueueError(message);
      }
    },
  });
}

/**
 * Reuses one Antigravity planning conversation for a session when available.
 *
 * Params:
 * credentials: AntigravityBridgeCredentials - Live local bridge credentials.
 * workspaceUri: string - Active workspace URI.
 * planningState: BridgeToolPlanningState | undefined - Mutable per-session planning state.
 *
 * Returns:
 * Promise<string> - Planning conversation id.
 */
async function getOrCreatePlanningConversation(
  credentials: AntigravityBridgeCredentials,
  workspaceUri: string,
  planningState?: BridgeToolPlanningState,
): Promise<string> {
  if (planningState?.planningConversationId) {
    return planningState.planningConversationId;
  }

  const conversationId = await startBridgeConversation(credentials, workspaceUri);
  if (planningState) {
    planningState.planningConversationId = conversationId;
  }
  return conversationId;
}

/**
 * Extracts human-readable text from a chat message content field.
 *
 * Params:
 * content: BridgeChatMessage["content"] | undefined - Mixed chat content.
 *
 * Returns:
 * string - Flattened text-only representation.
 */
function extractTextParts(content: BridgeChatMessage["content"] | undefined): string {
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


/**
 * Formats a single tool definition into a readable prompt summary.
 *
 * Params:
 * tool: BridgeChatToolDefinition - One OpenAI-compatible tool definition.
 *
 * Returns:
 * string - Prompt-friendly tool description.
 */
function summarizeTool(tool: BridgeChatToolDefinition): string {
  const name = tool.function?.name || "unknown";
  const parameters = tool.function?.parameters;
  const signature = summarizeSchema(parameters);
  const exactSchema = stringifyToolSchema(parameters);
  return [
    `- ${name}`,
    signature ? `  summary: ${signature}` : undefined,
    `  exact_schema_json: ${exactSchema}`,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

/**
 * Builds a planner prompt section for native Antigravity compatibility aliases.
 *
 * Params:
 * availableTools: Set<string> - Exact live OpenCode tools.
 *
 * Returns:
 * string - Prompt-friendly alias section.
 */
function buildNativeAliasPromptSection(availableTools: Set<string>): string {
  const aliases = getAvailableNativeAliases(availableTools);
  if (aliases.length === 0) {
    return "";
  }

  return aliases
    .map((alias) =>
      [
        `- ${alias.aliasName}`,
        `  maps_to: ${alias.targetTool}`,
        `  exact_schema_json: ${JSON.stringify(alias.schema)}`,
      ].join("\n"),
    )
    .join("\n");
}

/**
 * Builds one-line example CALL records for native compatibility aliases.
 *
 * Params:
 * availableTools: Set<string> - Exact live OpenCode tools.
 *
 * Returns:
 * string - Example CALL records.
 */
function buildNativeAliasExampleSection(availableTools: Set<string>): string {
  const aliases = getAvailableNativeAliases(availableTools);
  if (aliases.length === 0) {
    return "";
  }

  return aliases
    .slice(0, 8)
    .map((alias) => {
      const parameters = buildExampleValue(alias.schema, alias.aliasName);
      return JSON.stringify({
        action: "tool_call",
        tool_calls: [
          {
            name: alias.aliasName,
            arguments: isRecord(parameters) ? parameters : {},
          },
        ],
      });
    })
    .join("\n");
}

/**
 * Filters the native compatibility alias catalog to aliases supported by the live tool set.
 *
 * Params:
 * availableTools: Set<string> - Exact live OpenCode tools.
 *
 * Returns:
 * BridgeNativeToolAlias[] - Aliases whose target tool exists this turn.
 */
function getAvailableNativeAliases(availableTools: Set<string>): BridgeNativeToolAlias[] {
  return NATIVE_TOOL_ALIAS_CATALOG.filter((alias) => availableTools.has(alias.targetTool));
}

/**
 * Builds one example CALL record from the live tool schema.
 *
 * Params:
 * tool: BridgeChatToolDefinition - One OpenCode tool definition.
 *
 * Returns:
 * string - Example CALL record line.
 */
function buildToolExampleRecord(tool: BridgeChatToolDefinition): string {
  const name = tool.function?.name || "unknown";
  const parameters = buildExampleValue(tool.function?.parameters, name);
  const argumentsValue = isRecord(parameters) ? parameters : {};
  return JSON.stringify({
    action: "tool_call",
    tool_calls: [{ name, arguments: argumentsValue }],
  });
}

/**
 * Builds a compact example value from a JSON schema node.
 *
 * Params:
 * schema: unknown - Raw JSON schema node.
 * keyHint: string - Property or tool name hint.
 *
 * Returns:
 * unknown - Example value matching the schema shape.
 */
function buildExampleValue(schema: unknown, keyHint: string): unknown {
  if (!isRecord(schema)) {
    return {};
  }

  if (schema.default !== undefined) {
    return schema.default;
  }

  if (schema.const !== undefined) {
    return schema.const;
  }

  if (Array.isArray(schema.examples) && schema.examples.length > 0) {
    return schema.examples[0];
  }

  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    return schema.enum[0];
  }

  if (Array.isArray(schema.oneOf) && schema.oneOf.length > 0) {
    return buildExampleValue(schema.oneOf[0], keyHint);
  }

  if (Array.isArray(schema.anyOf) && schema.anyOf.length > 0) {
    return buildExampleValue(schema.anyOf[0], keyHint);
  }

  if (typeof schema.type === "string") {
    if (schema.type === "object") {
      return buildExampleObject(schema, keyHint);
    }

    if (schema.type === "array") {
      return [buildExampleValue(schema.items, singularize(keyHint))];
    }

    if (schema.type === "boolean") {
      return true;
    }

    if (schema.type === "integer" || schema.type === "number") {
      return 1;
    }

    if (schema.type === "string") {
      return buildExampleString(keyHint);
    }
  }

  if (isRecord(schema.properties)) {
    return buildExampleObject(schema, keyHint);
  }

  return {};
}

/**
 * Builds an example object from a JSON object schema.
 *
 * Params:
 * schema: Record<string, unknown> - JSON object schema.
 * keyHint: string - Parent property or tool name hint.
 *
 * Returns:
 * Record<string, unknown> - Example object value.
 */
function buildExampleObject(schema: Record<string, unknown>, keyHint: string): Record<string, unknown> {
  const properties = isRecord(schema.properties) ? schema.properties : {};
  const required = Array.isArray(schema.required)
    ? new Set(schema.required.filter((value): value is string => typeof value === "string"))
    : new Set<string>();

  const entries = Object.entries(properties);
  const selectedEntries =
    required.size > 0
      ? entries.filter(([name]) => required.has(name))
      : entries.slice(0, Math.min(entries.length, 2));

  if (selectedEntries.length === 0) {
    return {};
  }

  const result: Record<string, unknown> = {};
  for (const [name, propertySchema] of selectedEntries) {
    result[name] = buildExampleValue(propertySchema, name);
  }
  return result;
}

/**
 * Builds a generic example string value from the schema property name.
 *
 * Params:
 * keyHint: string - Property name hint.
 *
 * Returns:
 * string - Example string value.
 */
function buildExampleString(keyHint: string): string {
  const cleaned = keyHint.trim().replace(/[^a-zA-Z0-9_-]+/g, "_");
  return `<${cleaned || "string"}>`;
}

/**
 * Singularize a simple plural hint for example array items.
 *
 * Params:
 * value: string - Original property name.
 *
 * Returns:
 * string - Best-effort singular form.
 */
function singularize(value: string): string {
  if (value.endsWith("ies")) {
    return `${value.slice(0, -3)}y`;
  }
  if (value.endsWith("s") && value.length > 1) {
    return value.slice(0, -1);
  }
  return value;
}

/**
 * Normalizes tool identifiers across camelCase, kebab-case, and snake_case variants.
 *
 * Params:
 * value: string - Raw tool or alias identifier.
 *
 * Returns:
 * string - Lowercase underscore-normalized identifier.
 */
function normalizeToolIdentifier(value: string): string {
  return value
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/**
 * Serialize a tool schema exactly enough for the planner prompt.
 *
 * Params:
 * schema: unknown - Raw OpenCode tool parameter schema.
 *
 * Returns:
 * string - Stable JSON representation of the schema.
 */
function stringifyToolSchema(schema: unknown): string {
  try {
    return JSON.stringify(compactToolSchema(schema)) ?? "{}";
  } catch {
    return "{}";
  }
}

function compactToolSchema(schema: unknown, depth = 0): unknown {
  if (!isRecord(schema)) {
    if (Array.isArray(schema)) {
      return schema.slice(0, MAX_TOOL_ENUM_VALUES);
    }
    return schema ?? {};
  }

  const result: Record<string, unknown> = {};

  if (typeof schema.type === "string") {
    result.type = schema.type;
  }

  if (Array.isArray(schema.required) && schema.required.length > 0) {
    result.required = schema.required.slice(0, MAX_TOOL_SCHEMA_PROPERTIES);
  }

  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    result.enum = schema.enum.slice(0, MAX_TOOL_ENUM_VALUES);
    if (schema.enum.length > MAX_TOOL_ENUM_VALUES) {
      result.enum_truncated = true;
    }
  }

  if (typeof schema.default === "string" || typeof schema.default === "number" || typeof schema.default === "boolean") {
    result.default = schema.default;
  }

  if (schema.items !== undefined && depth < 2) {
    result.items = compactToolSchema(schema.items, depth + 1);
  }

  if (isRecord(schema.properties) && depth < 2) {
    const entries = Object.entries(schema.properties).slice(0, MAX_TOOL_SCHEMA_PROPERTIES);
    result.properties = Object.fromEntries(
      entries.map(([key, value]) => [key, compactToolSchema(value, depth + 1)]),
    );
    if (Object.keys(schema.properties).length > MAX_TOOL_SCHEMA_PROPERTIES) {
      result.properties_truncated = true;
    }
  }

  if (Array.isArray(schema.anyOf) && schema.anyOf.length > 0 && depth < 2) {
    result.anyOf = schema.anyOf.slice(0, 2).map((entry) => compactToolSchema(entry, depth + 1));
  }

  if (Array.isArray(schema.oneOf) && schema.oneOf.length > 0 && depth < 2) {
    result.oneOf = schema.oneOf.slice(0, 2).map((entry) => compactToolSchema(entry, depth + 1));
  }

  return Object.keys(result).length > 0 ? result : {};
}

/**
 * Normalizes model-produced tool argument values.
 *
 * Params:
 * raw: unknown - Parsed or unparsed tool argument payload.
 *
 * Returns:
 * unknown - Recursively normalized argument structure.
 */
function normalizeToolArguments(raw: unknown): unknown {
  if (raw == null) {
    return {};
  }

  if (typeof raw === "string") {
    const trimmed = raw.trim();
    const looksJson =
      (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
      (trimmed.startsWith("[") && trimmed.endsWith("]"));

    if (looksJson) {
      try {
        return normalizeToolArguments(JSON.parse(trimmed));
      } catch {
        return raw;
      }
    }

    return raw;
  }

  if (Array.isArray(raw)) {
    return raw.map((item) => normalizeToolArguments(item));
  }

  if (typeof raw === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(raw)) {
      result[key] = normalizeToolArguments(value);
    }
    return result;
  }

  return raw;
}

/**
 * Normalizes a planned tool call against the currently available OpenCode tools.
 *
 * Params:
 * call: BridgeToolCall - Planned tool call from the model.
 * availableTools: Set<string> - Exact tool names exposed by OpenCode.
 *
 * Returns:
 * BridgeToolCall - Alias-corrected tool call with Windows-safe arguments.
 */
function normalizePlannedToolCall(
  call: BridgeToolCall,
  availableTools: Set<string>,
  toolSchemas: Map<string, unknown>,
  workspaceDirectory?: string,
  scopedDirectory?: string,
): BridgeToolCall {
  const normalizedName = normalizeToolIdentifier(call.name);
  const normalizedToolNames = new Map(
    [...availableTools].map((toolName) => [normalizeToolIdentifier(toolName), toolName] as const),
  );
  const aliasMap: Record<string, string> = {
    ask_user_question: "question",
    ask_question: "question",
    user_question: "question",
    request_user_input: "question",
    list_dir: "bash",
    list_directory: "bash",
    list_files: "bash",
    read_directory: "bash",
    run_command: "bash",
    execute_command: "bash",
    exec_command: "bash",
    shell_command: "bash",
    terminal_command: "bash",
    read_file: "read",
    open_file: "read",
    grep_search: "grep",
    search_files: "grep",
    find: "glob",
    find_files: "glob",
    web_fetch: "webfetch",
    todo_write: "todowrite",
    readfile: "read",
    viewfile: "read",
    view_file: "read",
    writetofile: "write",
    write_to_file: "write",
    listdirectory: "bash",
    runinterminal: "bash",
    run_in_terminal: "bash",
    findfiles: "glob",
    findfiles2: "glob",
    grepsearch: "grep",
    codesearch: "grep",
    internalsearch: "grep",
    findallreferences: "grep",
    searchweb: "google_search",
    readurlcontent: "webfetch",
  };

  const mappedTool = aliasMap[normalizedName];
  const normalizedExactMatch = normalizedToolNames.get(normalizedName);
  const toolName = availableTools.has(call.name)
    ? call.name
    : normalizedExactMatch
      ? normalizedExactMatch
    : mappedTool && availableTools.has(mappedTool)
      ? mappedTool
      : call.name;

  let argumentsValue: Record<string, unknown> | unknown = normalizeToolArguments(call.arguments);
  if (!isRecord(argumentsValue)) {
    argumentsValue = { value: argumentsValue };
  }

  argumentsValue = normalizeScopedArguments(toolName, argumentsValue as Record<string, unknown>, workspaceDirectory, scopedDirectory);
  argumentsValue = translateNativeAliasArguments(
    normalizedName,
    toolName,
    argumentsValue as Record<string, unknown>,
    toolSchemas.get(toolName),
  );

  if (toolName === "read") {
    const filePath = extractToolPathArgument(argumentsValue as Record<string, unknown>);
    if (filePath && isDirectoryPath(filePath)) {
      if (availableTools.has("glob")) {
        return {
          name: "glob",
          arguments: {
            path: filePath,
            pattern: "**/*",
          },
        };
      }

      if (availableTools.has("bash")) {
        return {
          name: "bash",
          arguments: {
            command: `Get-ChildItem -Force -Recurse -File -LiteralPath ${quotePowerShell(filePath)}`,
            description: "List files in directory",
          },
        };
      }
    }
  }

  if (toolName === "question") {
    argumentsValue = buildQuestionArguments(argumentsValue as Record<string, unknown>);
  }

  if (toolName === "bash") {
    const normalizedBashPlan = normalizeBashFileOperationPlan(
      argumentsValue as Record<string, unknown>,
      availableTools,
      workspaceDirectory,
      scopedDirectory,
    );
    if (normalizedBashPlan) {
      return normalizedBashPlan;
    }

    if (
      normalizedName === "list_dir" ||
      normalizedName === "list_directory" ||
      normalizedName === "list_files" ||
      normalizedName === "listdirectory"
    ) {
      argumentsValue = {
        command: buildListDirCommand(argumentsValue as Record<string, unknown>),
        description: (argumentsValue as Record<string, unknown>).description ?? "Lists files in directory",
      };
    } else if (typeof (argumentsValue as Record<string, unknown>).command === "string") {
      argumentsValue = {
        ...(argumentsValue as Record<string, unknown>),
        command: normalizePowerShellCommand(String((argumentsValue as Record<string, unknown>).command)),
        description:
          typeof (argumentsValue as Record<string, unknown>).description === "string" &&
          String((argumentsValue as Record<string, unknown>).description).trim().length > 0
            ? (argumentsValue as Record<string, unknown>).description
            : "Runs a PowerShell command",
      };
    }
  }

  return {
    name: toolName,
    arguments: argumentsValue as Record<string, unknown>,
  };
}

/**
 * Normalizes a parsed plan against the available tool catalog.
 *
 * Params:
 * request: BridgeToolPlanningRequest - Original OpenAI tool request.
 * plan: BridgeToolCallPlan | null - Parsed plan candidate.
 *
 * Returns:
 * BridgeToolCallPlan | null - Plan with aliased tools normalized.
 */
export function normalizeToolCallPlan(
  request: BridgeToolPlanningRequest,
  plan: BridgeToolCallPlan | null,
  workspaceDirectory?: string,
): BridgeToolCallPlan | null {
  if (!plan || plan.action !== "tool_call") {
    return plan;
  }

  const scopedDirectory = extractConversationScopeDirectory(request, workspaceDirectory);
  const availableTools = new Set(
    (request.tools ?? [])
      .map((tool) => tool.function?.name)
      .filter((name): name is string => Boolean(name)),
  );
  const toolSchemas = new Map(
    (request.tools ?? [])
      .map((tool) => [tool.function?.name, tool.function?.parameters] as const)
      .filter((entry): entry is [string, unknown] => typeof entry[0] === "string"),
  );

  return {
    action: "tool_call",
    tool_calls: plan.tool_calls.map((call) =>
      normalizePlannedToolCall(call, availableTools, toolSchemas, workspaceDirectory, scopedDirectory),
    ),
  };
}

/**
 * Validates a parsed tool plan against common planner failure modes.
 *
 * Params:
 * request: BridgeToolPlanningRequest - Original OpenAI-style tool request.
 * plan: BridgeToolCallPlan | null - Parsed and normalized plan.
 * workspaceDirectory: string | undefined - Active workspace directory.
 *
 * Returns:
 * string | undefined - Human-readable validation failure reason.
 */
function validateToolPlan(
  request: BridgeToolPlanningRequest,
  plan: BridgeToolCallPlan | null,
  workspaceDirectory?: string,
): string | undefined {
  if (!plan) {
    return undefined;
  }

  const availableTools = new Set(
    (request.tools ?? [])
      .map((tool) => tool.function?.name)
      .filter((name): name is string => Boolean(name)),
  );
  const toolSchemas = new Map(
    (request.tools ?? [])
      .map((tool) => [tool.function?.name, tool.function?.parameters] as const)
      .filter((entry): entry is [string, unknown] => typeof entry[0] === "string"),
  );

  if (plan.action === "tool_call" && repeatsPreviousToolCalls(request, plan, availableTools, toolSchemas, workspaceDirectory)) {
    return "Do not repeat the same tool calls after their tool results are already present. Use the existing tool output to decide the next tool or final answer.";
  }

  if (plan.action === "final" && requiresPendingFileWrite(request, availableTools)) {
    return "The user asked for a file to be created or updated, so a prose-only answer is incomplete. Return a tool_call that performs the requested file change using an available tool.";
  }

  if (plan.action === "final" && !plan.content.trim()) {
    return "Return a non-empty final answer or a tool_call.";
  }

  if (plan.action === "tool_call" && containsBashFileOperations(request, plan)) {
    return "Do not use bash for file reads, file discovery, or file content search when dedicated file tools are available. Return tool_calls that use read, glob, or grep instead.";
  }

  return undefined;
}

/**
 * Parse, normalize, validate, and recover a tool plan from model text.
 *
 * Params:
 * request: BridgeToolPlanningRequest - Original OpenAI-style tool request.
 * output: string - Raw planner output.
 * workspaceDirectory: string | undefined - Active workspace directory.
 *
 * Returns:
 * { plan: BridgeToolCallPlan | null; validationReason?: string; recovered: boolean } - Validated plan state.
 */
function deriveValidatedToolPlan(
  request: BridgeToolPlanningRequest,
  output: string,
  workspaceDirectory?: string,
): { plan: BridgeToolCallPlan | null; validationReason?: string; recovered: boolean } {
  let plan = normalizeToolCallPlan(request, parseToolCallPlan(output), workspaceDirectory);
  let validationReason = validateToolPlan(request, plan, workspaceDirectory);
  if (!plan && !output.trim()) {
    validationReason = "Antigravity bridge planner returned no visible output.";
  }
  let recovered = false;

  if (validationReason) {
    const recoveredPlan = synthesizePendingFileWritePlan(request, plan, workspaceDirectory);
    if (recoveredPlan) {
      plan = recoveredPlan;
      validationReason = validateToolPlan(request, plan, workspaceDirectory);
      recovered = true;
    }
  }

  return {
    plan,
    validationReason,
    recovered,
  };
}

function deriveNativeToolPlan(
  request: BridgeToolPlanningRequest,
  nativeToolCalls: BridgeNativeToolCall[] | undefined,
  workspaceDirectory?: string,
): {
  plan: Extract<BridgeToolCallPlan, { action: "tool_call" }> | null;
  validationReason?: string;
} {
  if (!Array.isArray(nativeToolCalls) || nativeToolCalls.length === 0) {
    return { plan: null };
  }

  const normalizedPlan = normalizeToolCallPlan(
    request,
    {
      action: "tool_call",
      tool_calls: nativeToolCalls.map((call) => ({
        name: call.name,
        arguments: call.arguments,
      })),
    },
    workspaceDirectory,
  );

  if (!normalizedPlan || normalizedPlan.action !== "tool_call") {
    return { plan: null };
  }

  return {
    plan: normalizedPlan,
    validationReason: validateToolPlan(request, normalizedPlan, workspaceDirectory),
  };
}

function deriveEarlyPlannerToolPlan(
  request: BridgeToolPlanningRequest,
  planner: Pick<BridgePlannerUpdate, "response" | "nativeToolCalls">,
  workspaceDirectory?: string,
): Extract<BridgeToolCallPlan, { action: "tool_call" }> | null {
  const textResult = deriveValidatedToolPlan(request, planner.response ?? "", workspaceDirectory);
  if (textResult.plan?.action === "tool_call" && !textResult.validationReason) {
    return textResult.plan;
  }

  const nativeResult = deriveNativeToolPlan(request, planner.nativeToolCalls, workspaceDirectory);
  if (nativeResult.plan && !nativeResult.validationReason) {
    return nativeResult.plan;
  }

  return null;
}

function selectPreferredPlannerToolPlan(
  request: BridgeToolPlanningRequest,
  output: string,
  nativeToolCalls: BridgeNativeToolCall[] | undefined,
  workspaceDirectory?: string,
): {
  plan: BridgeToolCallPlan | null;
  validationReason?: string;
  recovered: boolean;
  source: "text" | "native";
} {
  const textResult = deriveValidatedToolPlan(request, output, workspaceDirectory);
  if (textResult.plan?.action === "tool_call" && !textResult.validationReason) {
    return {
      ...textResult,
      source: "text",
    };
  }

  const nativeResult = deriveNativeToolPlan(request, nativeToolCalls, workspaceDirectory);
  if (
    nativeResult.plan &&
    (!textResult.plan || textResult.plan.action === "final" || textResult.validationReason)
  ) {
    return {
      plan: nativeResult.plan,
      validationReason: nativeResult.validationReason,
      recovered: textResult.recovered,
      source: "native",
    };
  }

  return {
    ...textResult,
    source: "text",
  };
}

/**
 * Convert a file workspace URI back into a local directory path.
 *
 * Params:
 * workspaceUri: string - File URI used for the Antigravity conversation.
 *
 * Returns:
 * string | undefined - Decoded local directory path when possible.
 */
function workspaceDirectoryFromUri(workspaceUri: string): string | undefined {
  try {
    const url = new URL(workspaceUri);
    if (url.protocol !== "file:") {
      return undefined;
    }
    return path.normalize(decodeURIComponent(url.pathname.replace(/^\//, ""))).replace(/^([a-zA-Z])\:/, "$1:");
  } catch {
    return undefined;
  }
}

/**
 * Extract the most recent user-referenced directory scope from the conversation.
 *
 * Params:
 * request: BridgeToolPlanningRequest - Original chat request.
 * workspaceDirectory: string | undefined - Active workspace directory.
 *
 * Returns:
 * string | undefined - Absolute directory path when a scoped folder was referenced.
 */
function extractConversationScopeDirectory(
  request: BridgeToolPlanningRequest,
  workspaceDirectory?: string,
): string | undefined {
  if (!workspaceDirectory) {
    return undefined;
  }

  const messages = [...(request.messages ?? [])].reverse();
  for (const message of messages) {
    if (message.role !== "user" && message.role !== "assistant") {
      continue;
    }

    const text = extractTextParts(message.content);
    const references = extractPathReferences(text);
    for (let index = references.length - 1; index >= 0; index--) {
      const resolved = resolveConversationPathReference(references[index]!, workspaceDirectory);
      if (resolved) {
        return resolved;
      }
    }
  }

  return undefined;
}

/**
 * Extract raw file and directory reference tokens from conversation text.
 *
 * Params:
 * text: string - Raw conversation text.
 *
 * Returns:
 * string[] - Candidate path reference tokens.
 */
function extractPathReferences(text: string): string[] {
  const matches = new Set<string>();
  const patterns = [
    /@([^\s`"'<>]+(?:[\\/][^\s`"'<>]*)?)/g,
    /\b([A-Za-z]:\\[^\s`"'<>]+)/g,
    /\b((?:\.{1,2}[\\/])?[A-Za-z0-9._-]+(?:[\\/][A-Za-z0-9._@ -]+)+[\\/]?)/g,
  ];

  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const candidate = match[1]?.trim();
      if (candidate) {
        matches.add(candidate);
      }
    }
  }

  return [...matches];
}

/**
 * Resolve one conversation path token into an absolute directory path.
 *
 * Params:
 * reference: string - Raw reference token from the conversation.
 * workspaceDirectory: string - Active workspace directory.
 *
 * Returns:
 * string | undefined - Absolute scoped directory when the reference resolves.
 */
function resolveConversationPathReference(reference: string, workspaceDirectory: string): string | undefined {
  const cleaned = normalizeMentionPathSyntax(reference).replace(/[),.;:!?]+$/, "");
  if (!cleaned || /^[a-z]+:\/\//i.test(cleaned)) {
    return undefined;
  }

  const resolved = path.isAbsolute(cleaned)
    ? path.normalize(cleaned)
    : path.resolve(workspaceDirectory, cleaned);

  try {
    const stats = fs.statSync(resolved);
    return stats.isDirectory() ? resolved : path.dirname(resolved);
  } catch {
    return undefined;
  }
}

/**
 * Apply scoped directory hints to tool arguments when the model omits them.
 *
 * Params:
 * toolName: string - Normalized exact tool name.
 * raw: Record<string, unknown> - Parsed tool arguments.
 * workspaceDirectory: string | undefined - Workspace root directory.
 * scopedDirectory: string | undefined - Most recent referenced directory scope.
 *
 * Returns:
 * Record<string, unknown> - Arguments updated with scoped paths where appropriate.
 */
function normalizeScopedArguments(
  toolName: string,
  raw: Record<string, unknown>,
  workspaceDirectory?: string,
  scopedDirectory?: string,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...raw };
  const scope = scopedDirectory ?? workspaceDirectory;
  if (!scope) {
    return result;
  }

  for (const key of ["filePath", "filepath", "fileUri", "uri", "path", "dir", "directory", "directoryPath", "directoryPathUri", "workspaceFolder"]) {
    if (typeof result[key] === "string" && result[key].trim()) {
      const normalized = normalizeMentionPathSyntax(String(result[key]).trim());
      if (!path.isAbsolute(normalized)) {
        result[key] = path.join(scope, normalized);
      } else {
        result[key] = normalized;
      }
    }
  }

  if (toolName === "glob" && typeof result.pattern === "string" && result.pattern.trim()) {
    result.pattern = normalizeMentionPathSyntax(String(result.pattern).trim());
    if (!("path" in result) && scopedDirectory) {
      result.path = scopedDirectory;
    }
  }

  if (toolName === "grep" && typeof result.pattern === "string" && result.pattern.trim()) {
    result.pattern = normalizeMentionPathSyntax(String(result.pattern).trim());
    if (!("path" in result) && scopedDirectory) {
      result.path = scopedDirectory;
    }
  }

  return result;
}

/**
 * Translates native Antigravity alias argument names into the live OpenCode tool schema.
 *
 * Params:
 * normalizedName: string - Normalized alias or tool name from the planner.
 * toolName: string - Exact live OpenCode tool name.
 * raw: Record<string, unknown> - Parsed arguments.
 * schema: unknown - Live OpenCode tool schema for the destination tool.
 *
 * Returns:
 * Record<string, unknown> - Arguments reshaped for the destination tool.
 */
function translateNativeAliasArguments(
  normalizedName: string,
  toolName: string,
  raw: Record<string, unknown>,
  schema: unknown,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...raw };

  if (toolName === "read" && (normalizedName === "readfile" || normalizedName === "read_file" || normalizedName === "viewfile" || normalizedName === "view_file")) {
    const targetPath = extractToolPathArgument(result) ?? "";
    const fileKey = pickSchemaKey(schema, ["filePath", "filepath", "path"]) ?? "filePath";
    return {
      [fileKey]: targetPath,
    };
  }

  if (toolName === "write" && (normalizedName === "writetofile" || normalizedName === "write_to_file")) {
    const fileKey = pickSchemaKey(schema, ["filePath", "filepath", "path"]) ?? "filePath";
    const contentKey = pickSchemaKey(schema, ["content", "text", "value"]) ?? "content";
    return {
      [fileKey]: extractToolPathArgument(result) ?? "",
      [contentKey]: typeof result.content === "string" ? result.content : "",
    };
  }

  if (toolName === "glob" && (normalizedName === "find" || normalizedName === "find_files" || normalizedName === "findfiles" || normalizedName === "findfiles2")) {
    const pathKey = pickSchemaKey(schema, ["path", "dir", "directory", "directoryPath"]) ?? "path";
    const patternKey = pickSchemaKey(schema, ["pattern", "glob", "query"]) ?? "pattern";
    return {
      ...(extractToolPathArgument(result) ? { [pathKey]: extractToolPathArgument(result) } : {}),
      [patternKey]: pickStringArgument(result, ["pattern", "query", "name", "filePattern"]) ?? "**/*",
    };
  }

  if (toolName === "grep" && (normalizedName === "grepsearch" || normalizedName === "grep_search" || normalizedName === "codesearch" || normalizedName === "internalsearch")) {
    const pathKey = pickSchemaKey(schema, ["path", "dir", "directory", "directoryPath"]) ?? "path";
    const patternKey = pickSchemaKey(schema, ["pattern", "query", "text", "search"]) ?? "pattern";
    const translated: Record<string, unknown> = {
      [patternKey]: pickStringArgument(result, ["query", "pattern", "text", "search"]) ?? "",
    };
    const targetPath = extractToolPathArgument(result);
    if (targetPath) {
      translated[pathKey] = targetPath;
    }
    if (typeof result.caseSensitive === "boolean") {
      const caseKey = pickSchemaKey(schema, ["caseSensitive", "case_sensitive"]) ?? "caseSensitive";
      translated[caseKey] = result.caseSensitive;
    }
    return translated;
  }

  if (toolName === "google_search" && (normalizedName === "searchweb" || normalizedName === "search_web")) {
    const queryKey = pickSchemaKey(schema, ["query", "search_query", "q"]) ?? "query";
    return {
      [queryKey]: pickStringArgument(result, ["query", "q", "search_query"]) ?? "",
    };
  }

  if (toolName === "webfetch" && (normalizedName === "readurlcontent" || normalizedName === "read_url_content")) {
    const urlKey = pickSchemaKey(schema, ["url", "uri"]) ?? "url";
    return {
      [urlKey]: pickStringArgument(result, ["url", "uri"]) ?? "",
    };
  }

  if (toolName === "bash" && (normalizedName === "runinterminal" || normalizedName === "run_in_terminal")) {
    const commandKey = pickSchemaKey(schema, ["command", "cmd", "script"]) ?? "command";
    const descriptionKey = pickSchemaKey(schema, ["description", "explanation", "summary"]);
    return {
      ...(descriptionKey
        ? {
            [descriptionKey]:
              pickStringArgument(result, ["explanation", "description", "summary"]) ?? "Runs a PowerShell command",
          }
        : {}),
      [commandKey]: pickStringArgument(result, ["command", "commandLine", "cmd"]) ?? "",
    };
  }

  return result;
}

/**
 * Picks the first matching property key that exists in a JSON schema.
 *
 * Params:
 * schema: unknown - Live tool schema.
 * candidates: string[] - Candidate property names.
 *
 * Returns:
 * string | undefined - Matching schema key.
 */
function pickSchemaKey(schema: unknown, candidates: string[]): string | undefined {
  if (!isRecord(schema) || !isRecord(schema.properties)) {
    return undefined;
  }

  for (const candidate of candidates) {
    if (candidate in schema.properties) {
      return candidate;
    }
  }

  return undefined;
}

/**
 * Picks the first non-empty string argument from a record.
 *
 * Params:
 * raw: Record<string, unknown> - Parsed argument object.
 * candidates: string[] - Candidate keys.
 *
 * Returns:
 * string | undefined - First matching string value.
 */
function pickStringArgument(raw: Record<string, unknown>, candidates: string[]): string | undefined {
  for (const candidate of candidates) {
    const value = raw[candidate];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }

  return undefined;
}

/**
 * Extracts a filesystem path argument from a tool argument object.
 *
 * Params:
 * raw: Record<string, unknown> - Tool argument object.
 *
 * Returns:
 * string | undefined - Path argument when present.
 */
function extractToolPathArgument(raw: Record<string, unknown>): string | undefined {
  for (const key of ["filePath", "filepath", "fileUri", "uri", "path", "dir", "directory", "directoryPath", "directoryPathUri", "workspaceFolder"]) {
    const value = raw[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

/**
 * Checks whether a path currently resolves to a directory.
 *
 * Params:
 * candidate: string - Candidate filesystem path.
 *
 * Returns:
 * boolean - True when the candidate exists and is a directory.
 */
function isDirectoryPath(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Detects when the planner repeats the most recent tool calls after their results already exist.
 *
 * Params:
 * request: BridgeToolPlanningRequest - Original request with message history.
 * plan: Extract<BridgeToolCallPlan, { action: "tool_call" }> - Proposed tool plan.
 * availableTools: Set<string> - Exact live tool names.
 * workspaceDirectory: string | undefined - Active workspace directory.
 *
 * Returns:
 * boolean - True when the planner is stuck repeating the previous tool step.
 */
function repeatsPreviousToolCalls(
  request: BridgeToolPlanningRequest,
  plan: Extract<BridgeToolCallPlan, { action: "tool_call" }>,
  availableTools: Set<string>,
  toolSchemas: Map<string, unknown>,
  workspaceDirectory?: string,
): boolean {
  const messages = request.messages ?? [];
  const lastAssistantIndex = findLastAssistantToolCallIndex(messages);
  if (lastAssistantIndex === -1) {
    return false;
  }

  const subsequentMessages = messages.slice(lastAssistantIndex + 1);
  if (!subsequentMessages.some((message) => message.role === "tool")) {
    return false;
  }

  const assistantRecord = messages[lastAssistantIndex] as unknown as Record<string, unknown>;
  const priorToolCallsRaw = Array.isArray(assistantRecord.tool_calls) ? assistantRecord.tool_calls : [];
  if (priorToolCallsRaw.length === 0) {
    return false;
  }

  const scopedDirectory = extractConversationScopeDirectory(request, workspaceDirectory);
  const priorToolCalls = priorToolCallsRaw
    .map((toolCall): BridgeToolCall | null => {
      if (!isRecord(toolCall) || !isRecord(toolCall.function) || typeof toolCall.function.name !== "string") {
        return null;
      }

      return normalizePlannedToolCall(
        {
          name: toolCall.function.name,
          arguments: normalizeToolArguments(toolCall.function.arguments ?? {}),
        },
        availableTools,
        toolSchemas,
        workspaceDirectory,
        scopedDirectory,
      );
    })
    .filter((toolCall): toolCall is BridgeToolCall => Boolean(toolCall));

  if (priorToolCalls.length !== plan.tool_calls.length) {
    return false;
  }

  const currentSerialized = plan.tool_calls.map(serializeToolCall);
  const previousSerialized = priorToolCalls.map(serializeToolCall);
  return currentSerialized.every((value, index) => value === previousSerialized[index]);
}

/**
 * Finds the last assistant message that contains tool calls.
 *
 * Params:
 * messages: BridgeChatMessage[] | undefined - Message history.
 *
 * Returns:
 * number - Message index or -1 when absent.
 */
function findLastAssistantToolCallIndex(messages: BridgeChatMessage[] | undefined): number {
  const list = messages ?? [];
  for (let index = list.length - 1; index >= 0; index -= 1) {
    const message = list[index] as unknown as Record<string, unknown>;
    if (
      message.role === "assistant" &&
      Array.isArray(message.tool_calls) &&
      message.tool_calls.length > 0
    ) {
      return index;
    }
  }
  return -1;
}

/**
 * Checks whether the current user request still requires a write/edit tool call.
 *
 * Params:
 * request: BridgeToolPlanningRequest - Original request.
 * availableTools: Set<string> - Exact live tool names.
 *
 * Returns:
 * boolean - True when the user asked to create/update a file and no write/edit result exists yet.
 */
function requiresPendingFileWrite(
  request: BridgeToolPlanningRequest,
  availableTools: Set<string>,
): boolean {
  if (!availableTools.has("write") && !availableTools.has("edit")) {
    return false;
  }

  const latestUserIndex = findLatestUserMessageIndex(request.messages);
  const latestUserText = latestUserIndex === -1 ? "" : extractTextParts(request.messages?.[latestUserIndex]?.content);
  if (!latestUserText) {
    return false;
  }

  const lower = latestUserText.toLowerCase();
  const requestsWriteAction = /\b(make|create|write|save|update|edit|rewrite|modify)\b/.test(lower);
  const mentionsNamedFile = /\b[\w.-]+\.[a-z0-9]{1,8}\b/i.test(latestUserText);
  if (!requestsWriteAction || !mentionsNamedFile) {
    return false;
  }

  return !hasCompletedWriteOrEdit(request, latestUserIndex);
}

/**
 * Recover a missing write tool call when the model already produced the file body as a final response.
 *
 * Params:
 * request: BridgeToolPlanningRequest - Original request.
 * plan: BridgeToolCallPlan | null - Parsed planner result.
 * workspaceDirectory: string | undefined - Active workspace directory.
 *
 * Returns:
 * BridgeToolCallPlan | null - Synthetic write plan when recovery is safe enough.
 */
function synthesizePendingFileWritePlan(
  request: BridgeToolPlanningRequest,
  plan: BridgeToolCallPlan | null,
  workspaceDirectory?: string,
): BridgeToolCallPlan | null {
  const availableTools = new Set(
    (request.tools ?? [])
      .map((tool) => tool.function?.name)
      .filter((name): name is string => Boolean(name)),
  );
  if (!availableTools.has("write") || !requiresPendingFileWrite(request, availableTools)) {
    return null;
  }

  if (!plan || plan.action !== "final") {
    return null;
  }

  const filePath = resolveRequestedOutputFilePath(request, workspaceDirectory);
  const content = sanitizeRecoveredWriteContent(plan.content);
  if (!filePath || !content || looksLikeClarificationInsteadOfFileContent(content)) {
    return null;
  }

  return {
    action: "tool_call",
    tool_calls: [
      {
        name: "write",
        arguments: {
          filePath,
          content,
        },
      },
    ],
  };
}

/**
 * Resolve the latest explicitly named output file from the user request.
 *
 * Params:
 * request: BridgeToolPlanningRequest - Original request.
 * workspaceDirectory: string | undefined - Active workspace directory.
 *
 * Returns:
 * string | undefined - Absolute output path when recoverable.
 */
function resolveRequestedOutputFilePath(
  request: BridgeToolPlanningRequest,
  workspaceDirectory?: string,
): string | undefined {
  const latestUserText = extractLatestUserText(request);
  if (!latestUserText) {
    return undefined;
  }

  const namedFile = extractLatestNamedFileReference(latestUserText);
  if (!namedFile) {
    return undefined;
  }

  const scopeDirectory = extractConversationScopeDirectory(request, workspaceDirectory) ?? workspaceDirectory;
  if (!scopeDirectory && !path.isAbsolute(namedFile)) {
    return undefined;
  }

  return path.normalize(path.isAbsolute(namedFile) ? namedFile : path.resolve(scopeDirectory!, namedFile));
}

/**
 * Extract the last file-like token from a user request.
 *
 * Params:
 * text: string - Latest user request.
 *
 * Returns:
 * string | undefined - Raw file path token when found.
 */
function extractLatestNamedFileReference(text: string): string | undefined {
  const matches = [
    ...text.matchAll(/@?([A-Za-z]:\\[^\s`"'<>]+\.[A-Za-z0-9]{1,8})/g),
    ...text.matchAll(/@?((?:\.{1,2}[\\/])?[A-Za-z0-9._@ -]+(?:[\\/][A-Za-z0-9._@ -]+)*\.[A-Za-z0-9]{1,8})/g),
  ];
  const candidate = matches.at(-1)?.[1]?.trim();
  return candidate ? normalizeMentionPathSyntax(candidate) : undefined;
}

/**
 * Remove assistant-only framing from recovered file content.
 *
 * Params:
 * content: string - Final assistant text.
 *
 * Returns:
 * string - Candidate file body.
 */
function sanitizeRecoveredWriteContent(content: string): string {
  return content
    .replace(/^😈GEEKEED OUT FUCK YEAH 🚬\s*/u, "")
    .replace(/^GEEKEED OUT FUCK YEAH\s*/u, "")
    .trim();
}

/**
 * Reject obvious conversational follow-ups when attempting write recovery.
 *
 * Params:
 * content: string - Candidate file body.
 *
 * Returns:
 * boolean - True when the content still looks like a request for user direction.
 */
function looksLikeClarificationInsteadOfFileContent(content: string): boolean {
  const normalized = content.trim().toLowerCase();
  return (
    /\bwhat are we hunting\b/.test(normalized)
    || /\bwhat(?:'| i)s our real target\b/.test(normalized)
    || /\bgive me the target\b/.test(normalized)
    || /\bi'?m holding\b/.test(normalized)
    || (normalized.includes("?") && /\bdo you want me to\b/.test(normalized))
  );
}

/**
 * Checks whether the conversation already includes a completed write/edit tool result.
 *
 * Params:
 * request: BridgeToolPlanningRequest - Request with assistant/tool history.
 *
 * Returns:
 * boolean - True when write/edit was already called and a tool result followed.
 */
function hasCompletedWriteOrEdit(request: BridgeToolPlanningRequest, startIndex = 0): boolean {
  const messages = request.messages ?? [];
  for (let index = Math.max(startIndex + 1, 0); index < messages.length; index += 1) {
    const message = messages[index] as unknown as Record<string, unknown>;
    if (
      message.role === "assistant" &&
      Array.isArray(message.tool_calls) &&
      message.tool_calls.some(
        (toolCall) =>
          isRecord(toolCall) &&
          isRecord(toolCall.function) &&
          (toolCall.function.name === "write" || toolCall.function.name === "edit"),
      )
    ) {
      if (messages.slice(index + 1).some((candidate) => candidate.role === "tool")) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Finds the latest user message index in the request history.
 *
 * Params:
 * messages: BridgeChatMessage[] | undefined - Message history.
 *
 * Returns:
 * number - Latest user message index or -1.
 */
function findLatestUserMessageIndex(messages: BridgeChatMessage[] | undefined): number {
  const list = messages ?? [];
  for (let index = list.length - 1; index >= 0; index -= 1) {
    if (list[index]?.role === "user") {
      return index;
    }
  }
  return -1;
}

/**
 * Extracts the latest user message text from a request.
 *
 * Params:
 * request: BridgeToolPlanningRequest - Original tool planning request.
 *
 * Returns:
 * string - Latest user message text.
 */
function extractLatestUserText(request: BridgeToolPlanningRequest): string {
  const latestUser = [...(request.messages ?? [])].reverse().find((message) => message.role === "user");
  return latestUser ? extractTextParts(latestUser.content) : "";
}

/**
 * Serializes a tool call into a stable comparison key.
 *
 * Params:
 * call: BridgeToolCall - Tool call to serialize.
 *
 * Returns:
 * string - Stable comparison string.
 */
function serializeToolCall(call: BridgeToolCall): string {
  return JSON.stringify({
    name: call.name,
    arguments: call.arguments ?? {},
  });
}

/**
 * Normalize OpenCode @path mention syntax into a real filesystem path fragment.
 *
 * Params:
 * value: string - Raw path-like value.
 *
 * Returns:
 * string - Value with leading mention marker removed.
 */
function normalizeMentionPathSyntax(value: string): string {
  return value.startsWith("@") ? value.slice(1) : value;
}

/**
 * Build a compact structured summary of the parsed planner result for logs.
 *
 * Params:
 * plan: BridgeToolCallPlan | null - Parsed planner output.
 *
 * Returns:
 * Record<string, unknown> | null - Log-safe summary of the parsed result.
 */
function summarizeToolPlanForLog(plan: BridgeToolCallPlan | null): Record<string, unknown> | null {
  if (!plan) {
    return null;
  }

  if (plan.action === "final") {
    return {
      action: "final",
      contentLength: plan.content.length,
      contentPreview: plan.content.slice(0, 300),
    };
  }

  return {
    action: "tool_call",
    toolCalls: plan.tool_calls.map((call) => ({
      name: call.name,
      argumentsPreview: safeJsonPreview(call.arguments, 300),
    })),
  };
}

/**
 * Detects whether planner text still looks like structured control output.
 *
 * Params:
 * output: string - Raw planner text.
 *
 * Returns:
 * boolean - True when the output resembles a tool/final control record.
 */
function looksLikeStructuredPlannerOutput(output: string): boolean {
  const trimmed = stripPlannerPreamble(output);
  return (
    trimmed.startsWith("{") ||
    trimmed.startsWith("```") ||
    trimmed.startsWith("CALL:::") ||
    trimmed.startsWith("RESPONSE:::") ||
    /<tool>|<final>|<tool_call>/i.test(trimmed)
  );
}

/**
 * Remove any fixed leading header or wrapper prose before structured planner content.
 *
 * Params:
 * output: string - Raw planner output.
 *
 * Returns:
 * string - Output trimmed to the first structured planner marker when present.
 */
function stripPlannerPreamble(output: string): string {
  const trimmed = output.trim();
  if (!trimmed) {
    return trimmed;
  }

  const markers = ["```", "{", "CALL:::", "RESPONSE:::", "<tool>", "<final>", "<tool_call>"];
  let earliestIndex = -1;
  for (const marker of markers) {
    const index = trimmed.indexOf(marker);
    if (index === -1) {
      continue;
    }
    if (earliestIndex === -1 || index < earliestIndex) {
      earliestIndex = index;
    }
  }

  return earliestIndex === -1 ? trimmed : trimmed.slice(earliestIndex).trim();
}

/**
 * Convert an arbitrary value into a bounded JSON preview for log lines.
 *
 * Params:
 * value: unknown - Value to serialize.
 * limit: number - Maximum character count for the preview.
 *
 * Returns:
 * string - Bounded JSON or string preview.
 */
function safeJsonPreview(value: unknown, limit: number): string {
  try {
    const serialized = typeof value === "string" ? value : JSON.stringify(value);
    return serialized.length <= limit ? serialized : `${serialized.slice(0, limit)}...`;
  } catch {
    return "[unserializable]";
  }
}

/**
 * Parses a model response into either a final answer or tool-call plan.
 *
 * Params:
 * output: string - Raw model text output.
 *
 * Returns:
 * BridgeToolCallPlan | null - Parsed tool plan if the output is structured enough.
 */
export function parseToolCallPlan(output: string): BridgeToolCallPlan | null {
  const visibleCallCandidates = [
    ...new Set(
      [
        ...output.matchAll(/(?:^|\r?\n)CALL:::\s*(\{[^\r\n]*\})/g),
        ...output.matchAll(/(?:^|\r?\n)CALL:::\s*([\s\S]*?)(?=\r?\n(?:CALL:::|RESPONSE:::|DONE:::)|$)/g),
      ]
        .map((match) => match[1]?.trim())
        .filter((match): match is string => Boolean(match)),
    ),
  ];

  if (visibleCallCandidates.length > 0) {
    const toolCalls = visibleCallCandidates
      .map((candidate): BridgeToolCall | null => {
        try {
          const parsed = JSON.parse(candidate);
          if (!isRecord(parsed)) {
            return null;
          }

          const toolName = [parsed.name, parsed.tool, parsed.action].find(
            (value) => typeof value === "string" && value.trim().length > 0,
          );
          if (typeof toolName !== "string") {
            return null;
          }

          return {
            name: toolName,
            arguments: normalizeToolArguments(parsed.arguments ?? parsed.params ?? {}),
          };
        } catch {
          return null;
        }
      })
      .filter((toolCall): toolCall is BridgeToolCall => Boolean(toolCall && toolCall.name));

    if (toolCalls.length > 0) {
      return {
        action: "tool_call",
        tool_calls: toolCalls,
      };
    }
  }

  const visibleResponseMatch = output.match(/RESPONSE:::\s*([\s\S]*?)(?:\r?\nDONE:::|DONE:::|$)/i);
  if (visibleResponseMatch?.[1]) {
    return {
      action: "final",
      content: visibleResponseMatch[1].trim(),
    };
  }

  const finalMatch = output.match(/<final>\s*([\s\S]*?)\s*<\/final>/i);
  if (finalMatch?.[1]) {
    return {
      action: "final",
      content: finalMatch[1].trim(),
    };
  }

  const xmlToolMatches = [...output.matchAll(/<tool>\s*([\s\S]*?)\s*<\/tool>/gi)];
  if (xmlToolMatches.length > 0) {
    const toolCalls = xmlToolMatches
      .map((match): BridgeToolCall | null => {
        try {
          const parsed = JSON.parse(match[1] || "{}");
          if (!isRecord(parsed) || typeof parsed.name !== "string") {
            return null;
          }
          return {
            name: parsed.name,
            arguments: normalizeToolArguments(parsed.arguments),
          };
        } catch {
          return null;
        }
      })
      .filter((toolCall): toolCall is BridgeToolCall => Boolean(toolCall && toolCall.name));

    if (toolCalls.length > 0) {
      return {
        action: "tool_call",
        tool_calls: toolCalls,
      };
    }
  }

  const candidates = new Set<string>();
  const trimmed = output.trim();
  if (trimmed) {
    candidates.add(trimmed);
  }

  for (const match of output.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) {
    const candidate = match[1]?.trim();
    if (candidate) {
      candidates.add(candidate);
    }
  }

  const start = output.indexOf("{");
  const end = output.lastIndexOf("}");
  if (start !== -1 && end !== -1 && end > start) {
    candidates.add(output.slice(start, end + 1));
  }

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && parsed.action === "final" && typeof parsed.content === "string") {
        return { action: "final", content: parsed.content };
      }
      if (parsed && parsed.action === "tool_call" && Array.isArray(parsed.tool_calls)) {
        return {
          action: "tool_call",
          tool_calls: parsed.tool_calls
            .filter((toolCall: unknown) => isRecord(toolCall) && typeof toolCall.name === "string")
            .map((toolCall: unknown) => ({
              name: String((toolCall as Record<string, unknown>).name),
              arguments: normalizeToolArguments((toolCall as Record<string, unknown>).arguments),
            })),
        };
      }
    } catch {
      continue;
    }
  }

  const matches = [...output.matchAll(/<tool_call>\s*([\w.-]+)\s*(\{[\s\S]*?\})(?=\s*(?:<tool_call>|$))/g)];
  const toolCalls = matches
    .map((match): BridgeToolCall | null => {
      try {
        return {
          name: match[1] || "",
          arguments: normalizeToolArguments(JSON.parse(match[2] || "{}")),
        };
      } catch {
        return null;
      }
    })
    .filter((toolCall): toolCall is BridgeToolCall => Boolean(toolCall && toolCall.name));

  if (toolCalls.length === 0) {
    return null;
  }

  return {
    action: "tool_call",
    tool_calls: toolCalls,
  };
}

/**
 * Builds an OpenAI-compatible non-streaming `tool_calls` payload.
 *
 * Params:
 * model: string - Requested model identifier.
 * toolCalls: BridgeToolCall[] - Planned tool calls.
 * reasoningText: string | undefined - Optional reasoning text.
 *
 * Returns:
 * Record<string, unknown> - OpenAI-compatible response body.
 */
function buildToolCallPayload(
  model: string,
  toolCalls: BridgeToolCall[],
): Record<string, unknown> {
  const mapped = toolCalls.map((toolCall, index) => ({
    id: `call_${Date.now()}_${index}`,
    type: "function",
    function: {
      name: toolCall.name,
      arguments: JSON.stringify(toolCall.arguments ?? {}),
    },
  }));

  return {
    id: `antigravity-tools-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: "",
          tool_calls: mapped,
        },
        finish_reason: "tool_calls",
      },
    ],
  };
}

/**
 * Map bridge tool calls into OpenAI-compatible streamed tool_call objects.
 *
 * Params:
 * toolCalls: BridgeToolCall[] - Planned tool calls.
 *
 * Returns:
 * Array<Record<string, unknown>> - Stream-compatible tool call payloads.
 */
function mapToolCallsForStream(toolCalls: BridgeToolCall[]): Array<Record<string, unknown>> {
  return toolCalls.map((toolCall, index) => ({
    index,
    id: `call_${Date.now()}_${index}`,
    type: "function",
    function: {
      name: toolCall.name,
      arguments: JSON.stringify(toolCall.arguments ?? {}),
    },
  }));
}

/**
 * Quotes a string for safe PowerShell literal usage.
 *
 * Params:
 * value: string - Raw command argument value.
 *
 * Returns:
 * string - Single-quoted PowerShell literal.
 */
function quotePowerShell(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Converts simple Unix-y directory commands to PowerShell-safe equivalents.
 *
 * Params:
 * command: string - Raw shell command proposed by the model.
 *
 * Returns:
 * string - Windows-safe command line.
 */
function normalizePowerShellCommand(command: string): string {
  const trimmed = command.trim();
  if (!trimmed) {
    return command;
  }

  if (/^pwd$/i.test(trimmed)) {
    return "Get-Location";
  }

  const dirMatch = trimmed.match(/^(?:ls|dir)(?:\s+-[a-zA-Z]+)*\s*(.*)$/i);
  if (!dirMatch) {
    return command;
  }

  const target = dirMatch[1]?.trim();
  if (!target) {
    return "Get-ChildItem -Force";
  }

  return `Get-ChildItem -Force -LiteralPath ${quotePowerShell(target.replace(/^['"]|['"]$/g, ""))}`;
}

function normalizeBashFileOperationPlan(
  raw: Record<string, unknown>,
  availableTools: Set<string>,
  workspaceDirectory?: string,
  scopedDirectory?: string,
): BridgeToolCall | null {
  const command = typeof raw.command === "string" ? raw.command.trim() : "";
  if (!command) {
    return null;
  }

  const listAndReadMatch = command.match(
    /Get-ChildItem\b[\s\S]*?-(?:LiteralPath|Path)\s+(?<path>'[^']+'|"[^"]+"|[^\s|;]+)[\s\S]*?Get-Content\b/i,
  );
  if (listAndReadMatch?.groups?.path) {
    const targetDirectory = resolveShellPathCandidate(
      listAndReadMatch.groups.path,
      workspaceDirectory,
      scopedDirectory,
    );
    if (targetDirectory && availableTools.has("glob")) {
      return {
        name: "glob",
        arguments: {
          path: targetDirectory,
          pattern: "**/*",
        },
      };
    }
  }

  const getContentMatch = command.match(
    /^Get-Content\b[\s\S]*?-(?:LiteralPath|Path)\s+(?<path>'[^']+'|"[^"]+"|[^\s|;]+)/i,
  );
  if (getContentMatch?.groups?.path && availableTools.has("read")) {
    const targetFile = resolveShellPathCandidate(
      getContentMatch.groups.path,
      workspaceDirectory,
      scopedDirectory,
    );
    if (targetFile) {
      return {
        name: "read",
        arguments: {
          filePath: targetFile,
        },
      };
    }
  }

  const listOnlyMatch = command.match(
    /^Get-ChildItem\b[\s\S]*?-(?:LiteralPath|Path)\s+(?<path>'[^']+'|"[^"]+"|[^\s|;]+)/i,
  );
  if (listOnlyMatch?.groups?.path && availableTools.has("glob")) {
    const targetDirectory = resolveShellPathCandidate(
      listOnlyMatch.groups.path,
      workspaceDirectory,
      scopedDirectory,
    );
    if (targetDirectory) {
      return {
        name: "glob",
        arguments: {
          path: targetDirectory,
          pattern: "**/*",
        },
      };
    }
  }

  return null;
}

function resolveShellPathCandidate(
  rawPath: string,
  workspaceDirectory?: string,
  scopedDirectory?: string,
): string | undefined {
  const cleaned = rawPath.trim().replace(/^['"]|['"]$/g, "");
  if (!cleaned) {
    return undefined;
  }

  const normalized = cleaned.replace(/\//g, "\\");
  if (/^[a-zA-Z]:\\/.test(normalized)) {
    return path.normalize(normalized);
  }

  const baseDirectory = scopedDirectory || workspaceDirectory;
  if (!baseDirectory) {
    return undefined;
  }

  return path.resolve(baseDirectory, normalized);
}

function containsBashFileOperations(
  request: BridgeToolPlanningRequest,
  plan: Extract<BridgeToolCallPlan, { action: "tool_call" }>,
): boolean {
  const availableTools = new Set(
    (request.tools ?? [])
      .map((tool) => tool.function?.name)
      .filter((name): name is string => Boolean(name)),
  );

  if (!availableTools.has("bash")) {
    return false;
  }

  const hasDedicatedFileTools = availableTools.has("read") || availableTools.has("glob") || availableTools.has("grep");
  if (!hasDedicatedFileTools) {
    return false;
  }

  return plan.tool_calls.some((call) => {
    if (normalizeToolIdentifier(call.name) !== "bash" || !isRecord(call.arguments)) {
      return false;
    }

    const command = typeof call.arguments.command === "string" ? call.arguments.command : "";
    return /\bGet-Content\b|\bcat\b|\btype\b/i.test(command);
  });
}

/**
 * Builds a PowerShell command for directory listing tool aliases.
 *
 * Params:
 * raw: Record<string, unknown> - Parsed tool argument object.
 *
 * Returns:
 * string - PowerShell command line.
 */
function buildListDirCommand(raw: Record<string, unknown>): string {
  const target = [raw.path, raw.dir, raw.directory, raw.target, raw.DirectoryPath, raw.directoryPath, raw.directoryPathUri].find(
    (value) => typeof value === "string" && value.trim().length > 0,
  ) as string | undefined;
  const normalizedTarget = target?.trim().replace(/^['"]|['"]$/g, "");
  const recursive = raw.recursive === true;

  if (!normalizedTarget || normalizedTarget === ".") {
    return recursive ? "Get-ChildItem -Force -Recurse" : "Get-ChildItem -Force";
  }

  return recursive
    ? `Get-ChildItem -Force -Recurse -LiteralPath ${quotePowerShell(normalizedTarget)}`
    : `Get-ChildItem -Force -LiteralPath ${quotePowerShell(normalizedTarget)}`;
}

/**
 * Normalizes free-form question arguments into the OpenCode `question` schema.
 *
 * Params:
 * raw: Record<string, unknown> - Parsed tool argument object.
 *
 * Returns:
 * Record<string, unknown> - Question-tool-ready arguments.
 */
function buildQuestionArguments(raw: Record<string, unknown>): Record<string, unknown> {
  if (Array.isArray(raw.questions)) {
    return raw;
  }

  const questionText = [raw.question, raw.prompt, raw.text].find(
    (value) => typeof value === "string" && value.trim().length > 0,
  ) as string | undefined;
  if (!questionText) {
    return raw;
  }

  return {
    questions: [
      {
        header: typeof raw.header === "string" && raw.header.trim() ? raw.header.trim() : "Question",
        question: questionText.trim(),
        options: Array.isArray(raw.options) ? raw.options : [],
        custom: raw.custom ?? true,
        multiple: raw.multiple,
      },
    ],
  };
}

/**
 * Checks whether a value is a plain object record.
 *
 * Params:
 * value: unknown - Value to inspect.
 *
 * Returns:
 * boolean - True when the value is a non-array object.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Creates a compact one-line schema signature for a tool.
 *
 * Params:
 * schema: unknown - Raw JSON schema object.
 *
 * Returns:
 * string - Compact parameter signature.
 */
function summarizeSchema(schema: unknown): string {
  if (!isRecord(schema)) {
    return "";
  }

  const properties = isRecord(schema.properties) ? schema.properties : {};
  const required = Array.isArray(schema.required)
    ? new Set(schema.required.filter((value): value is string => typeof value === "string"))
    : new Set<string>();

  const entries = Object.entries(properties)
    .slice(0, 12)
    .map(([name, value]) => `${name}:${summarizeSchemaType(value)}${required.has(name) ? "*" : ""}`);

  const suffix = Object.keys(properties).length > 12 ? ", ..." : "";
  return entries.join(", ") + suffix;
}

/**
 * Summarizes one schema node into a compact type hint.
 *
 * Params:
 * schema: unknown - Property schema node.
 *
 * Returns:
 * string - Short type summary.
 */
function summarizeSchemaType(schema: unknown): string {
  if (!isRecord(schema)) {
    return "any";
  }

  if (typeof schema.type === "string") {
    if (schema.type === "array") {
      return `array<${summarizeSchemaType(schema.items)}>`;
    }
    if (schema.type === "object") {
      return "object";
    }
    return schema.type;
  }

  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    const values = schema.enum.slice(0, 3).map((value) => String(value)).join("|");
    return `enum(${values}${schema.enum.length > 3 ? "|..." : ""})`;
  }

  return "any";
}
