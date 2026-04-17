export interface AntigravityBridgeModelInfo {
  id: string;
  name: string;
  requestedModel: string;
  description?: string;
}

const DEFAULT_REQUESTED_MODEL = "MODEL_PLACEHOLDER_M35";
const PLACEHOLDER_MODEL_BASE = 1000;
const PLACEHOLDER_MODEL_MAX = 1150;

const KNOWN_NUMERIC_MODELS: Record<number, string> = {
  246: "GOOGLE_GEMINI_2_5_PRO",
  281: "CLAUDE_4_SONNET",
  282: "CLAUDE_4_SONNET_THINKING",
  290: "CLAUDE_4_OPUS",
  291: "CLAUDE_4_OPUS_THINKING",
  312: "GOOGLE_GEMINI_2_5_FLASH",
  313: "GOOGLE_GEMINI_2_5_FLASH_THINKING",
  333: "CLAUDE_4_5_SONNET",
  334: "CLAUDE_4_5_SONNET_THINKING",
  340: "CLAUDE_4_5_HAIKU",
  341: "CLAUDE_4_5_HAIKU_THINKING",
  342: "OPENAI_GPT_OSS_120B_MEDIUM",
};

const CURATED_MODELS: AntigravityBridgeModelInfo[] = [
  {
    id: "antigravity-bridge",
    name: "Antigravity IDE Selected",
    requestedModel: DEFAULT_REQUESTED_MODEL,
    description: "Route requests through the local Antigravity IDE server using the IDE-selected main chat model.",
  },
  {
    id: "antigravity-bridge-m35",
    name: "Antigravity Bridge M35",
    requestedModel: "MODEL_PLACEHOLDER_M35",
  },
  {
    id: "antigravity-bridge-m50",
    name: "Antigravity Bridge M50",
    requestedModel: "MODEL_PLACEHOLDER_M50",
  },
  {
    id: "antigravity-bridge-claude-sonnet-4.6-thinking",
    name: "Claude Sonnet 4.6 (Thinking)",
    requestedModel: "MODEL_PLACEHOLDER_M35",
    description: "Current Antigravity selector mapping captured from the live model config.",
  },
  {
    id: "antigravity-bridge-claude-opus-4.6-thinking",
    name: "Claude Opus 4.6 (Thinking)",
    requestedModel: "MODEL_PLACEHOLDER_M26",
    description: "Current Antigravity selector mapping captured from the live model config.",
  },
  {
    id: "antigravity-bridge-gemini-3.1-pro-high",
    name: "Gemini 3.1 Pro (High)",
    requestedModel: "MODEL_PLACEHOLDER_M37",
    description: "Current Antigravity selector mapping captured from the live model config.",
  },
  {
    id: "antigravity-bridge-gemini-3.1-pro-low",
    name: "Gemini 3.1 Pro (Low)",
    requestedModel: "MODEL_PLACEHOLDER_M36",
    description: "Current Antigravity selector mapping captured from the live model config.",
  },
  {
    id: "antigravity-bridge-gemini-3-flash",
    name: "Gemini 3 Flash",
    requestedModel: "MODEL_PLACEHOLDER_M47",
    description: "Current Antigravity selector mapping captured from the live model config.",
  },
  {
    id: "antigravity-bridge-gpt-oss-120b-medium",
    name: "GPT-OSS 120B (Medium)",
    requestedModel: "OPENAI_GPT_OSS_120B_MEDIUM",
    description: "Current Antigravity selector mapping captured from the live model config.",
  },
  {
    id: "antigravity-bridge-claude-4.5-sonnet",
    name: "Claude 4.5 Sonnet",
    requestedModel: "CLAUDE_4_5_SONNET",
  },
  {
    id: "antigravity-bridge-claude-4.5-sonnet-thinking",
    name: "Claude 4.5 Sonnet Thinking",
    requestedModel: "CLAUDE_4_5_SONNET_THINKING",
  },
  {
    id: "antigravity-bridge-claude-4.5-haiku",
    name: "Claude 4.5 Haiku",
    requestedModel: "CLAUDE_4_5_HAIKU",
  },
  {
    id: "antigravity-bridge-claude-4.5-haiku-thinking",
    name: "Claude 4.5 Haiku Thinking",
    requestedModel: "CLAUDE_4_5_HAIKU_THINKING",
  },
  {
    id: "antigravity-bridge-gemini-2.5-pro",
    name: "Gemini 2.5 Pro",
    requestedModel: "GOOGLE_GEMINI_2_5_PRO",
  },
  {
    id: "antigravity-bridge-gemini-2.5-flash",
    name: "Gemini 2.5 Flash",
    requestedModel: "GOOGLE_GEMINI_2_5_FLASH",
  },
  {
    id: "antigravity-bridge-gemini-2.5-flash-thinking",
    name: "Gemini 2.5 Flash Thinking",
    requestedModel: "GOOGLE_GEMINI_2_5_FLASH_THINKING",
  },
];

const MODEL_LOOKUP = new Map(
  CURATED_MODELS.flatMap((model) => [
    [model.id, model.requestedModel] as const,
    [model.name, model.requestedModel] as const,
  ]),
);

export function listAntigravityBridgeModels(): AntigravityBridgeModelInfo[] {
  return CURATED_MODELS;
}

function numericModelIdToRequestedModel(value: string): string | undefined {
  const numericId = Number.parseInt(value, 10);
  if (!Number.isFinite(numericId)) {
    return undefined;
  }

  if (numericId >= PLACEHOLDER_MODEL_BASE && numericId <= PLACEHOLDER_MODEL_MAX) {
    return `MODEL_PLACEHOLDER_M${numericId - PLACEHOLDER_MODEL_BASE}`;
  }

  return KNOWN_NUMERIC_MODELS[numericId];
}

export function resolveAntigravityBridgeRequestedModel(model: string | undefined): string {
  const requested = model?.trim();
  if (!requested) {
    return DEFAULT_REQUESTED_MODEL;
  }

  if (requested.startsWith("MODEL_")) {
    return requested;
  }

  if (MODEL_LOOKUP.has(requested)) {
    return MODEL_LOOKUP.get(requested)!;
  }

  if (/^\d+$/.test(requested)) {
    const numericRequested = numericModelIdToRequestedModel(requested);
    if (numericRequested) {
      return numericRequested;
    }
  }

  const shorthandMatch = requested.match(/^m(\d+)$/i);
  if (shorthandMatch?.[1]) {
    return `MODEL_PLACEHOLDER_M${shorthandMatch[1]}`;
  }

  if (/^PLACEHOLDER_M\d+$/i.test(requested)) {
    return `MODEL_${requested.toUpperCase()}`;
  }

  if (/^[A-Z0-9_]+$/.test(requested)) {
    return requested;
  }

  return DEFAULT_REQUESTED_MODEL;
}
