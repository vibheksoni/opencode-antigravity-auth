export interface AntigravityBridgeModelInfo {
  id: string;
  name: string;
  requestedModel: string;
  description?: string;
}

const DEFAULT_REQUESTED_MODEL = "MODEL_PLACEHOLDER_M35";

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
    id: "antigravity-bridge-claude-4.5-sonnet",
    name: "Claude 4.5 Sonnet",
    requestedModel: "MODEL_CLAUDE_4_5_SONNET",
  },
  {
    id: "antigravity-bridge-claude-4.5-sonnet-thinking",
    name: "Claude 4.5 Sonnet Thinking",
    requestedModel: "MODEL_CLAUDE_4_5_SONNET_THINKING",
  },
  {
    id: "antigravity-bridge-claude-4.5-haiku",
    name: "Claude 4.5 Haiku",
    requestedModel: "MODEL_CLAUDE_4_5_HAIKU",
  },
  {
    id: "antigravity-bridge-claude-4.5-haiku-thinking",
    name: "Claude 4.5 Haiku Thinking",
    requestedModel: "MODEL_CLAUDE_4_5_HAIKU_THINKING",
  },
  {
    id: "antigravity-bridge-gemini-2.5-pro",
    name: "Gemini 2.5 Pro",
    requestedModel: "MODEL_GOOGLE_GEMINI_2_5_PRO",
  },
  {
    id: "antigravity-bridge-gemini-2.5-flash",
    name: "Gemini 2.5 Flash",
    requestedModel: "MODEL_GOOGLE_GEMINI_2_5_FLASH",
  },
  {
    id: "antigravity-bridge-gemini-2.5-flash-thinking",
    name: "Gemini 2.5 Flash Thinking",
    requestedModel: "MODEL_GOOGLE_GEMINI_2_5_FLASH_THINKING",
  },
];

const MODEL_LOOKUP = new Map(CURATED_MODELS.map((model) => [model.id, model.requestedModel]));

export function listAntigravityBridgeModels(): AntigravityBridgeModelInfo[] {
  return CURATED_MODELS;
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

  if (/^[A-Z0-9_]+$/.test(requested)) {
    return `MODEL_${requested}`;
  }

  return DEFAULT_REQUESTED_MODEL;
}
