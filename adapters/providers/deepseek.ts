// DeepSeek adapter (OpenAI-compatible API) with reasoning-effort support.
//
// Added in this fork. Upstream had no deepseek provider, and the only adapter
// whose base URL is configurable is openrouter - so reaching DeepSeek meant
// repointing OPENROUTER_BASE_URL at api.deepseek.com, which burns the
// OpenRouter route for anything else. A first-class provider keeps both usable
// at once and lets the @effort suffix work here too.
import { FastifyReply } from "fastify";
import { streamOpenAICompatible, withStatus } from "./openai-compat.js";
import type { AnthropicRequest, ReasoningLevel } from "../types.js";

const DS_BASE = process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com/v1";

// DeepSeek V4 exposes reasoning through `reasoning_effort`. The accepted set
// varies by snapshot (low/medium/high on some, low/high/max on the -0731
// line), so only the two levels with no portable spelling are normalised:
//   none    -> omit the field, leaving thinking at the model default
//   minimal -> low
// Anything else is passed through verbatim; an upstream that rejects a level
// will say so rather than silently ignoring it. Falls back to
// DEEPSEEK_REASONING_EFFORT when the model string carries no @suffix.
function toReasoningEffort(r?: ReasoningLevel): string | undefined {
  const level = r || process.env.DEEPSEEK_REASONING_EFFORT?.toLowerCase();
  if (!level || level === "none") return undefined;
  if (level === "minimal") return "low";
  return level;
}

export async function chatDeepSeek(
  res: FastifyReply,
  body: AnthropicRequest,
  model: string,
  apiKey?: string,
  reasoning?: ReasoningLevel,
) {
  if (!apiKey) {
    throw withStatus(401, "Missing DEEPSEEK_API_KEY. Set it in ~/.claude-proxy/.env");
  }

  return streamOpenAICompatible(res, body, {
    url: `${DS_BASE}/chat/completions`,
    headers: { Authorization: `Bearer ${apiKey}` },
    model,
    label: "deepseek",
    reasoningEffort: toReasoningEffort(reasoning),
    // Non-negotiable here, and not conditional on `reasoning` being set: V4 is
    // in thinking mode by default, so omitting the echo 400s the second turn of
    // every tool-using conversation. See toOpenAIMessagesWithTools.
    echoReasoning: true,
  });
}
