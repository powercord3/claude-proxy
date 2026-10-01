// OpenRouter adapter (OpenAI-compatible API) with full tool calling support
import { FastifyReply } from "fastify";
import { streamOpenAICompatible, withStatus } from "./openai-compat.js";
import type { AnthropicRequest, ReasoningLevel } from "../types.js";

const OR_BASE = process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1";

// Map the proxy's ReasoningLevel onto the OpenAI-compatible `reasoning_effort`
// field. Upstream enums vary by model (DeepSeek V4 accepts low/high/max on the
// newer snapshots; most OpenAI-compatible endpoints accept low/medium/high), so
// only the two levels with no portable spelling are normalised here:
//   none    -> omit the field entirely, leaving the provider default
//   minimal -> low, the nearest level every provider accepts
// Anything else is passed through verbatim. Falls back to
// OPENROUTER_REASONING_EFFORT when the model string carries no @suffix.
function toReasoningEffort(r?: ReasoningLevel): string | undefined {
  const level = r || process.env.OPENROUTER_REASONING_EFFORT?.toLowerCase();
  if (!level || level === "none") return undefined;
  if (level === "minimal") return "low";
  return level;
}

// Split an optional "#<provider-slug>" pin off the model string:
//   "openai/gpt-oss-120b#baseten/fp4" -> ["openai/gpt-oss-120b", "baseten/fp4"]
//
// OpenRouter pins a provider ONLY through the body-level `provider` object; a
// provider slug appended to the model id is not a pin. Measured 2026-09-14:
// `model: "openai/gpt-oss-120b:baseten"` returns HTTP 200 and is served by
// CoreWeave -- the suffix is silently ignored, so the request looks fine and
// runs on the wrong provider. The marker therefore has to be stripped here and
// re-expressed as `provider.only`, never forwarded upstream.
//
// '#' is the marker rather than ':' because ':' is load-bearing in real
// OpenRouter slugs -- ":nitro", ":floor", ":free", ":batch" are all genuine
// model variants, and claiming the text after a colon as a provider name would
// break every one of them. '#' is not legal in an OpenRouter model id, so it
// cannot collide.
//
// `only` is used without `allow_fallbacks: false`: `only` already guarantees no
// other PROVIDER can serve the request, while leaving OpenRouter free to retry
// that provider's other endpoints (BaseTen publishes two for gpt-oss-120b).
// Adding allow_fallbacks:false would give up that resilience for no extra pin.
function splitProviderPin(model: string): [string, string | undefined] {
  const idx = model.indexOf("#");
  if (idx === -1) return [model, undefined];
  const slug = model.slice(idx + 1).trim();
  return [model.slice(0, idx), slug || undefined];
}

export async function chatOpenRouter(
  res: FastifyReply,
  body: AnthropicRequest,
  model: string,
  apiKey?: string,
  reasoning?: ReasoningLevel,
) {
  if (!apiKey) {
    throw withStatus(401, "Missing OPENROUTER_API_KEY. Set it in ~/.claude-proxy/.env");
  }

  const [modelId, providerPin] = splitProviderPin(model);
  if (providerPin) {
    console.log(`[ccx] openrouter: pinning ${modelId} to provider "${providerPin}"`);
  }

  const headers: Record<string, string> = { Authorization: `Bearer ${apiKey}` };
  if (process.env.OPENROUTER_REFERER) headers["HTTP-Referer"] = process.env.OPENROUTER_REFERER;
  if (process.env.OPENROUTER_TITLE) headers["X-Title"] = process.env.OPENROUTER_TITLE;

  return streamOpenAICompatible(res, body, {
    url: `${OR_BASE}/chat/completions`,
    headers,
    model: modelId,
    label: "openrouter",
    reasoningEffort: toReasoningEffort(reasoning),
    ...(providerPin
      ? { extraBody: { provider: { only: [providerPin] } } }
      : {}),
  });
}
