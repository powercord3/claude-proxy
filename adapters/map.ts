// Provider parsing and message mapping utilities
import {
  AnthropicMessage,
  AnthropicRequest,
  ProviderKey,
  ProviderModel,
  ReasoningLevel,
  ServiceTier,
} from "./types.js";
import { readFileSync, statSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const VALID_REASONING: ReasoningLevel[] = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];

// Fast mode rides a `!` marker on the model string: "codex-oauth:gpt-6-sol@medium!fast".
//
// A second marker rather than a second @suffix, because the two are orthogonal and a slot
// wants to set them independently. Reusing @ would force every effort tier to be spelled
// twice (@medium and @medium-fast), which is exactly the combinatorial table model-slot.py's
// MODELS comment already warns about for effort itself.
//
// `!` is safe here: it appears in no provider prefix, no model slug upstream, and no
// reasoning level, so lastIndexOf("!") cannot collide with the rest of the grammar.
const SERVICE_TIER_ALIASES: Record<string, ServiceTier> = {
  fast: "priority",      // what the Codex CLI and the API guide both call it
  priority: "priority",  // the catalog id, and what the response echoes back
};

/**
 * Split a trailing `!tier` marker off a model string.
 *
 * Returns the string with the marker removed and the tier it named, or the string untouched
 * and `undefined` when there is no marker or the marker is not one we know. An unrecognised
 * marker is deliberately LEFT ON the string rather than silently dropped: it then fails to
 * match a shortcut or a model slug and surfaces as an upstream error, where dropping it would
 * quietly run at standard speed while the alias claimed otherwise.
 */
function extractServiceTier(field: string): [string, ServiceTier | undefined] {
  const bangIdx = field.lastIndexOf("!");
  if (bangIdx <= 0) return [field, undefined];
  const tier = SERVICE_TIER_ALIASES[field.slice(bangIdx + 1).toLowerCase()];
  return tier ? [field.slice(0, bangIdx), tier] : [field, undefined];
}

const PROVIDER_PREFIXES: ProviderKey[] = [
  "openai",
  "openrouter",
  "gemini",
  "gemini-oauth",
  "codex-oauth",
  "glm",
  "anthropic",
  "cline-pass",
  "deepseek",
];

// Model shortcuts - add your own aliases here
const MODEL_SHORTCUTS: Record<string, string> = {
  // GLM shortcuts (Z.AI). glm-5.2 is the current flagship (1M context, Max thinking).
  g: "glm:glm-5.2",
  glm: "glm:glm-5.2",
  glm52z: "glm:glm-5.2",   // explicit Z.AI GLM-5.2 (glm52 alone = the Cline route)
  glm51: "glm:glm-5.1",
  glm5: "glm:glm-5",
  glm47: "glm:glm-4.7",
  glm45: "glm:glm-4.5",
  glm5or: "openrouter:z-ai/glm-5",
  flash: "glm:glm-4.7-flash",
  // MiniMax shortcuts
  minimax: "openrouter:minimax/minimax-m2.5",
  mm: "openrouter:minimax/minimax-m2.5",
  m25: "openrouter:minimax/minimax-m2.5",
  // Claude shortcuts (for API users) — bare aliases, no dated suffixes
  opus: "anthropic:claude-opus-4-8",
  sonnet: "anthropic:claude-sonnet-5",
  haiku: "anthropic:claude-haiku-4-5",
  // Gemini OAuth shortcuts (Google account login)
  gemini: "gemini-oauth:gemini-3.1-pro-preview",
  "gemini-pro": "gemini-oauth:gemini-3.1-pro-preview",
  "gemini-flash": "gemini-oauth:gemini-3-flash-preview",
  "gemini-3p": "gemini-oauth:gemini-3-pro-preview",
  "gemini-31p": "gemini-oauth:gemini-3.1-pro-preview",
  "gemini-31f": "gemini-oauth:gemini-3.1-flash-preview",
  "gemini-25p": "gemini-oauth:gemini-2.5-pro",
  "gemini-25f": "gemini-oauth:gemini-2.5-flash",
  gp: "gemini-oauth:gemini-3.1-pro-preview",
  gf: "gemini-oauth:gemini-3-flash-preview",
  // Codex shortcuts — GPT-6 Sol/Luna, GPT-5.6 Terra. Sol = frontier, Terra = balanced, Luna = fast/cheap.
  // Every codex model takes an @level suffix: low | medium | high | xhigh | max.
  codex: "codex-oauth:gpt-6-sol@high", // default = Sol frontier at High
  cx: "codex-oauth:gpt-6-sol@high",
  // GPT-6 Sol — latest frontier agentic coding model. Defaults to High
  // effort; override with @low/@medium/@xhigh/@max.
  sol: "codex-oauth:gpt-6-sol@high",
  gpt56: "codex-oauth:gpt-6-sol@high",
  gpt6: "codex-oauth:gpt-6-sol@high",
  "gpt-5.6-sol": "codex-oauth:gpt-6-sol@high",
  "gpt-6-sol": "codex-oauth:gpt-6-sol@high",
  // GPT-5.6 Terra — balanced everyday model
  terra: "codex-oauth:gpt-5.6-terra",
  "gpt-5.6-terra": "codex-oauth:gpt-5.6-terra",
  // GPT-6 Luna — fast, affordable model (no ultra tier upstream)
  luna: "codex-oauth:gpt-6-luna",
  "gpt-5.6-luna": "codex-oauth:gpt-6-luna",
  "gpt-6-luna": "codex-oauth:gpt-6-luna",
  // GPT-5.5 — previous frontier, still selectable
  gpt55: "codex-oauth:gpt-5.5",
  "gpt-5.5": "codex-oauth:gpt-5.5",
  // Reasoning-level shortcuts (apply to Sol, the default frontier).
  // Ladder: low < medium < high < xhigh (Extra High) < max.
  fast: "codex-oauth:gpt-6-sol@low",     // Light — quick, lighter reasoning
  smart: "codex-oauth:gpt-6-sol@medium", // Medium — Codex default
  deep: "codex-oauth:gpt-6-sol@high",    // High — deeper reasoning
  xhigh: "codex-oauth:gpt-6-sol@xhigh",  // Extra High — one rung below max
  extra: "codex-oauth:gpt-6-sol@xhigh",  // alias for xhigh (the app labels it "Extra High")
  max: "codex-oauth:gpt-6-sol@max",      // Max — top reasoning we expose
  think: "codex-oauth:gpt-6-sol@max",    // alias for max
  // DeepSeek direct API (api.deepseek.com, DEEPSEEK_API_KEY).
  // deepseek-v4-flash is a rolling alias that currently resolves to the
  // DeepSeek-V4-Flash-0731 snapshot upstream.
  deepseek: "deepseek:deepseek-v4-flash",
  ds: "deepseek:deepseek-v4-flash",
  dsflash: "deepseek:deepseek-v4-flash",
  dspro: "deepseek:deepseek-v4-pro",
  // ClinePass shortcuts (Cline subscription — included models, $0 per call)
  cline: "cline-pass:glm-5.2",
  clinepass: "cline-pass:glm-5.2",
  cp: "cline-pass:glm-5.2",
  cpglm: "cline-pass:glm-5.2",
  glm52: "cline-pass:glm-5.2",
  cpkimi: "cline-pass:kimi-k2.7-code",
  cpkimi26: "cline-pass:kimi-k2.6",
  cpqwen: "cline-pass:qwen3.7-max",
  cpqwenplus: "cline-pass:qwen3.7-plus",
  cpminimax: "cline-pass:minimax-m3",
  cpdeepseek: "cline-pass:deepseek-v4-pro",
  cpflash: "cline-pass:deepseek-v4-flash",
  cpmimo: "cline-pass:mimo-v2.5-pro",
  cpmimo25: "cline-pass:mimo-v2.5",
};

// User-defined shortcuts live in ~/.claude-proxy/shortcuts.json and are merged
// over the built-ins above (user entries win on key collision). The file is
// re-read whenever its mtime changes, so an alias can be repointed while the
// proxy is running. That indirection is what makes an A/B toggle possible:
// Claude Code reads its model configuration only at process startup, so
// flipping a slot on the Claude Code side would cost a session restart, whereas
// flipping what an alias resolves to here takes effect on the next request.
//
// Example ~/.claude-proxy/shortcuts.json:
//   { "haiku-ab": "codex-oauth:gpt-6-luna@max" }   // toggle on
//   { "haiku-ab": "anthropic:claude-haiku-4-5" }     // toggle off
const USER_SHORTCUTS_PATH = join(homedir(), ".claude-proxy", "shortcuts.json");
let userShortcutsCache: Record<string, string> = {};
let userShortcutsMtime = 0;

function loadUserShortcuts(): Record<string, string> {
  try {
    const mtime = statSync(USER_SHORTCUTS_PATH).mtimeMs;
    if (mtime !== userShortcutsMtime) {
      const parsed = JSON.parse(readFileSync(USER_SHORTCUTS_PATH, "utf8"));
      const next: Record<string, string> = {};
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof v === "string") next[k.toLowerCase()] = v;
      }
      userShortcutsCache = next;
      userShortcutsMtime = mtime;
      console.log(`[ccx] Loaded ${Object.keys(next).length} user shortcut(s) from ${USER_SHORTCUTS_PATH}`);
    }
  } catch {
    // Missing, unreadable, or malformed file: fall back to the built-ins. Reset
    // the cache so deleting the file genuinely disables the user shortcuts
    // rather than leaving the last good copy live.
    if (userShortcutsMtime !== 0) {
      userShortcutsCache = {};
      userShortcutsMtime = 0;
    }
  }
  return userShortcutsCache;
}

/**
 * Is `name` defined in the user's shortcuts file right now?
 *
 * The permission-classifier reroute in anthropic-gateway.ts is opt-in, and this is what makes
 * it so: it fires only when the alias it would route to actually exists. Without this the
 * detector would have to decide what an absent alias means, and the tempting reading -- route
 * it anyway, to some fallback -- turns a missing key into a silently wrong model adjudicating
 * permission decisions. Re-reads on mtime like every other shortcut lookup, so defining the
 * alias arms the reroute on the next request with no restart.
 */
export function userShortcutDefined(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(loadUserShortcuts(), name.toLowerCase());
}

// When Claude Code internally sends claude-haiku-*/claude-sonnet-* requests
// (Explore subagent, title gen, quota checks), remap to the active provider's
// equivalent so it doesn't fail when Anthropic keys aren't configured.
// Also the recovery probe's model per lane (lane-probe.ts): the cheapest thing each lane serves.
export const PROVIDER_FAST_MODEL: Partial<Record<ProviderKey, string>> = {
  "codex-oauth": "gpt-6-luna",
  "gemini-oauth": "gemini-3-flash-preview",
  "openai": "gpt-5-mini",
  "openrouter": "anthropic/claude-haiku-4-5",
  "glm": "glm-4.7-flash",
  "cline-pass": "glm-5.2",
  "deepseek": "deepseek-v4-flash",
};

const PROVIDER_MAIN_MODEL: Partial<Record<ProviderKey, string>> = {
  "codex-oauth": "gpt-6-sol",
  "gemini-oauth": "gemini-3.1-pro-preview",
  "openai": "gpt-5.5",
  "openrouter": "anthropic/claude-sonnet-5",
  "glm": "glm-5.2",
  "cline-pass": "glm-5.2",
  "deepseek": "deepseek-v4-pro",
};

/**
 * Parse provider and model from the model field
 * Supports formats: "provider:model" or "provider/model"
 * Falls back to defaults if no valid prefix found
 */
export function parseProviderModel(
  modelField: string,
  defaults?: ProviderModel,
): ProviderModel {
  if (!modelField) {
    if (defaults) return defaults;
    throw new Error("Missing 'model' in request");
  }

  // Extract the !tier marker BEFORE the @reasoning suffix. Order is load-bearing: with
  // "sol@medium!fast" the @-parser slices "medium!fast", which is not a valid level, so it
  // would decline the suffix and leave the whole marker embedded in the model slug. Stripping
  // the marker first leaves the exact string the @-parser was already written against.
  const [markerStripped, explicitTier] = extractServiceTier(modelField);
  let serviceTier: ServiceTier | undefined = explicitTier;
  modelField = markerStripped;

  // Extract @reasoning suffix (e.g. "codex@high", "gemini@low")
  let reasoning: ReasoningLevel | undefined;
  let rawField = modelField;
  const atIdx = modelField.lastIndexOf("@");
  if (atIdx > 0) {
    const suffix = modelField.slice(atIdx + 1).toLowerCase() as ReasoningLevel;
    if (VALID_REASONING.includes(suffix)) {
      reasoning = suffix;
      rawField = modelField.slice(0, atIdx);
    }
  }

  // Expand shortcuts first. User-defined shortcuts take precedence over the
  // built-ins so an alias can be repointed without editing this file.
  const shortcutKey = rawField.toLowerCase();
  let expanded =
    loadUserShortcuts()[shortcutKey] || MODEL_SHORTCUTS[shortcutKey] || rawField;

  // A shortcut may itself carry a !tier marker — which is the normal case, since this is how
  // an agent slot in shortcuts.json turns fast mode on for one agent and not the rest. Strip
  // it on the same explicit-wins rule the @suffix uses just below, and for the same reason:
  // what the caller typed is a decision, what the alias holds is a default.
  const [expandedStripped, expandedTier] = extractServiceTier(expanded);
  expanded = expandedStripped;
  if (!serviceTier) serviceTier = expandedTier;

  // A shortcut may itself embed an @reasoning suffix (e.g. "fast" → "codex-oauth:gpt-5.5@low").
  // Re-extract so the suffix doesn't end up in the model slug. An explicit @reasoning typed
  // by the user wins over one baked into a shortcut.
  const expandedAtIdx = expanded.lastIndexOf("@");
  if (expandedAtIdx > 0) {
    const expandedSuffix = expanded.slice(expandedAtIdx + 1).toLowerCase() as ReasoningLevel;
    if (VALID_REASONING.includes(expandedSuffix)) {
      if (!reasoning) reasoning = expandedSuffix;
      expanded = expanded.slice(0, expandedAtIdx);
    }
  }

  // Auto-detect Claude models (start with "claude-") → route to anthropic,
  // OR remap to the active provider's equivalent when not using anthropic.
  // This handles Claude Code's internal haiku/sonnet calls (Explore subagent,
  // title generation, quota checks) that would otherwise fail through the proxy.
  if (expanded.toLowerCase().startsWith("claude-")) {
    // CCX_CLAUDE_PASSTHROUGH=1 disables the remap below and always routes
    // claude-* to the anthropic provider.
    //
    // The remap exists for users with no Anthropic credentials, so Claude
    // Code's internal haiku/sonnet calls don't 401. But `defaults` is the
    // global `active` provider, which the gateway reassigns on EVERY
    // non-anthropic request. So in a mixed setup - some slots on Codex, the
    // rest on a real Claude subscription - a single Codex request flips
    // `active`, and the next genuine claude-opus-* request is silently
    // rewritten to that provider's main model. The user gets GPT where they
    // asked for Opus, with only a log line to show for it. Anyone deliberately
    // running Claude and non-Claude models side by side wants this off.
    const claudePassthrough = process.env.CCX_CLAUDE_PASSTHROUGH === "1";
    if (!claudePassthrough && defaults && defaults.provider !== "anthropic") {
      const lc = expanded.toLowerCase();
      const isOpus = lc.includes("opus");
      const fast = PROVIDER_FAST_MODEL[defaults.provider];
      const main = PROVIDER_MAIN_MODEL[defaults.provider];
      const remapped = isOpus ? (main || defaults.model) : (fast || defaults.model);
      console.log(`[ccx] Remapping internal Claude model "${expanded}" → ${defaults.provider}:${remapped}`);
      return { provider: defaults.provider, model: remapped, reasoning, serviceTier };
    }
    return { provider: "anthropic", model: expanded, reasoning, serviceTier };
  }

  // Auto-detect GLM models (start with "glm-") and route to glm
  if (expanded.toLowerCase().startsWith("glm-")) {
    return { provider: "glm", model: expanded, reasoning, serviceTier };
  }

  const sep = expanded.includes(":")
    ? ":"
    : expanded.includes("/")
      ? "/"
      : null;
  if (!sep) {
    const base = defaults ?? { provider: "glm" as ProviderKey, model: expanded };
    return { ...base, reasoning: reasoning ?? base.reasoning, serviceTier: serviceTier ?? base.serviceTier };
  }

  const [maybeProv, ...rest] = expanded.split(sep);
  const prov = maybeProv.toLowerCase() as ProviderKey;

  if (!PROVIDER_PREFIXES.includes(prov)) {
    const base = defaults ?? { provider: "glm" as ProviderKey, model: expanded };
    return { ...base, reasoning: reasoning ?? base.reasoning, serviceTier: serviceTier ?? base.serviceTier };
  }

  return { provider: prov, model: rest.join(sep), reasoning, serviceTier };
}

/**
 * Warn if tools are being used with providers that may not support them
 */
export function warnIfTools(
  req: AnthropicRequest,
  provider: ProviderKey,
): void {
  if (req.tools && req.tools.length > 0) {
    // GLM, Anthropic, Gemini OAuth, and Codex OAuth support tools natively
    if (provider !== "glm" && provider !== "anthropic" && provider !== "gemini-oauth" && provider !== "codex-oauth") {
      console.warn(
        `[proxy] Warning: ${provider} may not fully support Anthropic-style tools. Passing through anyway.`,
      );
    }
  }
}

/**
 * Convert Anthropic content to plain text
 */
export function toPlainText(content: AnthropicMessage["content"]): string {
  if (typeof content === "string") return content;
  return content
    .map((c) => {
      if (typeof c === "string") return c;
      if (c.type === "text") return c.text;
      if (c.type === "tool_result") {
        // Convert tool results to text representation
        if (typeof c.content === "string") return c.content;
        return JSON.stringify(c.content);
      }
      return "";
    })
    .join("");
}

/**
 * Convert Anthropic messages to OpenAI format
 */
export function toOpenAIMessages(messages: AnthropicMessage[]) {
  return messages.map((m) => ({
    role: m.role,
    content: toPlainText(m.content),
  }));
}

/**
 * Convert Anthropic messages to Gemini format
 */
export function toGeminiContents(messages: AnthropicMessage[]) {
  return messages.map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: toPlainText(m.content) }],
  }));
}
