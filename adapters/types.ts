// TypeScript type definitions for Anthropic API subset
// Used across all adapter files

export type AnthropicImageSource =
  | { type: "base64"; media_type: string; data: string }
  | { type: "url"; url: string; media_type?: string };

export type AnthropicContentBlock =
  | { type: "text"; text: string; cache_control?: unknown }
  | { type: "image"; source: AnthropicImageSource; cache_control?: unknown }
  | { type: "tool_use"; id: string; name: string; input: unknown; cache_control?: unknown }
  | {
      type: "tool_result";
      tool_use_id: string;
      content: string | AnthropicContentBlock[];
      is_error?: boolean;
      cache_control?: unknown;
    }
  | { type: "thinking"; thinking: string; signature?: string; cache_control?: unknown }
  | { type: "redacted_thinking"; data: string; cache_control?: unknown };

export type AnthropicMessage = {
  role: "user" | "assistant" | "system" | "developer";
  content: string | AnthropicContentBlock[];
};

export type AnthropicTool = {
  name: string;
  description?: string;
  input_schema?: unknown;
};

export type AnthropicToolChoice =
  | { type: "auto" }
  | { type: "any" }
  | { type: "tool"; name: string }
  | { type: "none" };

export type AnthropicRequest = {
  model: string;
  messages: AnthropicMessage[];
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  stream?: boolean;
  tools?: AnthropicTool[];
  tool_choice?: AnthropicToolChoice;
  system?: string | Array<{ type: string; text: string }>;
  metadata?: { user_id?: string };
};

export type ProviderKey = "openai" | "openrouter" | "gemini" | "gemini-oauth" | "codex-oauth" | "glm" | "anthropic" | "cline-pass" | "deepseek";

export type ReasoningLevel = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

// Codex "fast mode" — the `service_tier` field on the Responses body. Orthogonal to
// ReasoningLevel: effort buys more thinking, this buys the same thinking sooner.
//
// The wire value is "priority", NOT "fast". "Fast" is only the display name: the model
// catalog at ~/.codex/models_cache.json lists `service_tiers: [{id: "priority", name:
// "Fast", description: "1.5x speed, increased usage"}]`, and the API docs note that GPT-5.6
// and earlier echo back `priority` whichever spelling was sent. Accept both on input for the
// sake of anyone typing what the docs' example shows, and normalise to the id.
export type ServiceTier = "priority";

export type ProviderModel = {
  provider: ProviderKey;
  model: string;
  reasoning?: ReasoningLevel;
  serviceTier?: ServiceTier;
};
