import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export interface BridgeInlineMedia {
  mimeType: string;
  inlineData: string;
}

export interface BridgeUserTurn {
  prompt: string;
  media: BridgeInlineMedia[];
}

type BridgeMessageLike = {
  role?: string;
  content?: unknown;
};

type BridgeImagePartLike = {
  type?: unknown;
  text?: unknown;
  image?: unknown;
  dataUrl?: unknown;
  url?: unknown;
  image_url?: unknown;
};

const DEFAULT_IMAGE_MIME_TYPE = "image/png";
const MIME_TYPE_BY_EXTENSION = new Map<string, string>([
  [".avif", "image/avif"],
  [".bmp", "image/bmp"],
  [".gif", "image/gif"],
  [".heic", "image/heic"],
  [".heif", "image/heif"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".webp", "image/webp"],
]);

/**
 * Collects text-only content from a bridge-compatible message payload.
 *
 * Params:
 * content: unknown - Raw OpenAI-compatible message content.
 *
 * Returns:
 * string - Concatenated text blocks for the message.
 */
export function extractBridgeText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .map((part) => {
      if (!part || typeof part !== "object") {
        return "";
      }

      const record = part as Record<string, unknown>;
      if (typeof record.text === "string") {
        return record.text;
      }

      return "";
    })
    .filter(Boolean)
    .join("\n");
}

/**
 * Extracts the latest user turn text and image attachments from OpenAI-compatible chat messages.
 *
 * Params:
 * request: { messages?: BridgeMessageLike[] } - Chat completion payload forwarded by the proxy.
 *
 * Returns:
 * Promise<BridgeUserTurn> - Latest user text plus normalized inline media blocks for Antigravity.
 */
export async function extractBridgeUserTurn(request: { messages?: BridgeMessageLike[] }): Promise<BridgeUserTurn> {
  const messages = request.messages ?? [];
  const latestUser = [...messages].reverse().find((message) => message.role === "user");
  const systemPrompt = collectSystemPrompt(messages);

  if (!latestUser) {
    return {
      prompt: buildFallbackPrompt(messages),
      media: [],
    };
  }

  return {
    prompt: composePromptWithSystem(extractBridgeText(latestUser.content), systemPrompt),
    media: await extractBridgeMedia(latestUser.content),
  };
}

/**
 * Builds a fallback prompt from the full message list when no latest user turn is available.
 *
 * Params:
 * messages: BridgeMessageLike[] - Request message list.
 *
 * Returns:
 * string - Flattened role-prefixed transcript text.
 */
export function buildFallbackPrompt(messages: BridgeMessageLike[]): string {
  return messages
    .map((message) => {
      const text = extractBridgeText(message.content);
      return text ? `${String(message.role ?? "user").toUpperCase()}: ${text}` : "";
    })
    .filter(Boolean)
    .join("\n\n");
}

/**
 * Collect system messages so the bridge can preserve OpenCode's instruction layer.
 *
 * Params:
 * messages: BridgeMessageLike[] - Full request message list.
 *
 * Returns:
 * string - Combined system instruction text.
 */
function collectSystemPrompt(messages: BridgeMessageLike[]): string {
  return messages
    .filter((message) => message.role === "system")
    .map((message) => extractBridgeText(message.content))
    .filter(Boolean)
    .join("\n\n");
}

/**
 * Prefix the latest user prompt with the active system instruction text.
 *
 * Params:
 * userPrompt: string - Latest user turn text.
 * systemPrompt: string - Combined OpenCode system prompt text.
 *
 * Returns:
 * string - Prompt body sent to the Antigravity bridge.
 */
function composePromptWithSystem(userPrompt: string, systemPrompt: string): string {
  if (systemPrompt && userPrompt) {
    return [
      "You are receiving one active user request plus background OpenCode instructions.",
      "Your job is to complete the USER_REQUEST.",
      "Use the BACKGROUND_INSTRUCTIONS only as governing constraints.",
      "Do not answer, summarize, acknowledge, or roleplay about the instruction block itself.",
      "If any background instruction only tells you to confirm understanding, acknowledge rules, or wait for a command, treat that instruction as already satisfied and continue with the USER_REQUEST.",
      "",
      "<USER_REQUEST>",
      userPrompt,
      "</USER_REQUEST>",
      "",
      "<BACKGROUND_INSTRUCTIONS>",
      systemPrompt,
      "</BACKGROUND_INSTRUCTIONS>",
    ].join("\n");
  }

  if (systemPrompt) {
    return [
      "You are receiving background OpenCode instructions only.",
      "Treat them as governing rules, not as a user message to answer.",
      "If any instruction only asks for confirmation or acknowledgement, treat it as already satisfied.",
      "",
      "<BACKGROUND_INSTRUCTIONS>",
      systemPrompt,
      "</BACKGROUND_INSTRUCTIONS>",
    ].join("\n");
  }

  return userPrompt;
}

/**
 * Normalizes user content into Antigravity inline media payloads.
 *
 * Params:
 * content: unknown - Raw user message content.
 *
 * Returns:
 * Promise<BridgeInlineMedia[]> - Inline media blocks ready for SendUserCascadeMessage.
 */
export async function extractBridgeMedia(content: unknown): Promise<BridgeInlineMedia[]> {
  if (!Array.isArray(content)) {
    return [];
  }

  const media: BridgeInlineMedia[] = [];

  for (const part of content) {
    const source = extractImageSource(part);
    if (!source) {
      continue;
    }

    const normalized = await normalizeImageSource(source);
    if (normalized) {
      media.push(normalized);
    }
  }

  return media;
}

/**
 * Resolves an image source string from an OpenAI-compatible content block.
 *
 * Params:
 * part: unknown - One user content block.
 *
 * Returns:
 * string | undefined - Image source URL/data URL/path when present.
 */
function extractImageSource(part: unknown): string | undefined {
  if (!part || typeof part !== "object") {
    return undefined;
  }

  const record = part as BridgeImagePartLike;
  const kind = typeof record.type === "string" ? record.type : "";

  if (kind === "image_url" || kind === "input_image") {
    return extractImageUrl(record.image_url);
  }

  if (kind === "image") {
    if (typeof record.image === "string") {
      return record.image;
    }
    if (typeof record.dataUrl === "string") {
      return record.dataUrl;
    }
    if (typeof record.url === "string") {
      return record.url;
    }
  }

  if (typeof record.dataUrl === "string") {
    return record.dataUrl;
  }

  return undefined;
}

/**
 * Extracts a concrete string URL from OpenAI image_url payloads.
 *
 * Params:
 * value: unknown - `image_url` field from a content block.
 *
 * Returns:
 * string | undefined - Normalized string URL when present.
 */
function extractImageUrl(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }

  if (!value || typeof value !== "object") {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  return typeof record.url === "string" ? record.url : undefined;
}

/**
 * Converts a source URL/path into Antigravity inline media.
 *
 * Params:
 * source: string - Data URL, remote URL, file URL, or absolute local path.
 *
 * Returns:
 * Promise<BridgeInlineMedia | undefined> - Inline media payload, or undefined if unsupported.
 */
async function normalizeImageSource(source: string): Promise<BridgeInlineMedia | undefined> {
  if (!source) {
    return undefined;
  }

  if (source.startsWith("data:")) {
    return parseDataUrl(source);
  }

  if (/^https?:\/\//i.test(source)) {
    return fetchRemoteImage(source);
  }

  if (source.startsWith("file://")) {
    return readLocalImage(fileURLToPath(source));
  }

  if (path.isAbsolute(source)) {
    return readLocalImage(source);
  }

  return undefined;
}

/**
 * Parses a data URL into inline media.
 *
 * Params:
 * source: string - Data URL string.
 *
 * Returns:
 * BridgeInlineMedia | undefined - Parsed inline media, or undefined on invalid input.
 */
function parseDataUrl(source: string): BridgeInlineMedia | undefined {
  const match = source.match(/^data:([^;,]+)?(;base64)?,([\s\S]*)$/);
  if (!match) {
    return undefined;
  }

  const mimeType = match[1] || DEFAULT_IMAGE_MIME_TYPE;
  const isBase64 = !!match[2];
  const payload = match[3] || "";
  const inlineData = isBase64
    ? payload.replace(/\s+/g, "")
    : Buffer.from(decodeURIComponent(payload), "utf8").toString("base64");

  if (!inlineData) {
    return undefined;
  }

  return {
    mimeType,
    inlineData,
  };
}

/**
 * Downloads a remote image and converts it into inline media.
 *
 * Params:
 * source: string - Remote HTTP(S) image URL.
 *
 * Returns:
 * Promise<BridgeInlineMedia | undefined> - Downloaded inline media, or undefined on failure.
 */
async function fetchRemoteImage(source: string): Promise<BridgeInlineMedia | undefined> {
  const response = await fetch(source);
  if (!response.ok) {
    throw new Error(`Bridge image fetch failed with HTTP ${response.status}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  const mimeType = normalizeMimeType(response.headers.get("content-type"), source);

  return {
    mimeType,
    inlineData: Buffer.from(arrayBuffer).toString("base64"),
  };
}

/**
 * Reads a local image from disk and converts it into inline media.
 *
 * Params:
 * filePath: string - Absolute local file path.
 *
 * Returns:
 * Promise<BridgeInlineMedia | undefined> - Inline media payload, or undefined if the file is unreadable.
 */
async function readLocalImage(filePath: string): Promise<BridgeInlineMedia | undefined> {
  const bytes = await fs.readFile(filePath);
  return {
    mimeType: normalizeMimeType(undefined, filePath),
    inlineData: bytes.toString("base64"),
  };
}

/**
 * Chooses a stable MIME type from headers or path suffix.
 *
 * Params:
 * contentType: string | null | undefined - Header-provided content type.
 * source: string - Source URL or file path.
 *
 * Returns:
 * string - Best-effort MIME type for the image payload.
 */
function normalizeMimeType(contentType: string | null | undefined, source: string): string {
  const headerMimeType = contentType?.split(";")[0]?.trim();
  if (headerMimeType) {
    return headerMimeType;
  }

  const extension = path.extname(source).toLowerCase();
  return MIME_TYPE_BY_EXTENSION.get(extension) || DEFAULT_IMAGE_MIME_TYPE;
}
