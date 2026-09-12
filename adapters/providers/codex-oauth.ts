// Codex adapter — Anthropic Messages API → OpenAI Responses API (/v1/responses)
//
// Mirrors what the real Codex CLI sends on the wire. References:
//   codex-rs/core/src/client.rs::build_responses_request
//   codex-rs/codex-api/src/common.rs::ResponsesApiRequest
//   codex-rs/codex-api/src/sse/responses.rs
//   codex-rs/login/src/auth/default_client.rs (originator / User-Agent)
//   codex-rs/model-provider/src/bearer_auth_provider.rs (ChatGPT-Account-ID)
//
// Wire decisions:
//   - Always POST to /v1/responses (OAuth → ChatGPT backend, API key → api.openai.com).
//     Codex CLI does NOT use /v1/chat/completions. Wire format is responses-only.
//   - Stream tools/text/reasoning incrementally as Anthropic SSE events.
//   - Cache encrypted_content reasoning blobs per session and re-inject on next turn.

import { createHash } from "crypto";
import { readFileSync, writeFileSync } from "fs";
import { homedir, release, arch, type } from "os";
import { join } from "path";
import type { EventSourceMessage } from "eventsource-parser";
import { createParser } from "eventsource-parser";
import { FastifyReply } from "fastify";
import { getCodexAccessToken, getCodexAccountId } from "../openai-auth.js";
import { sendEvent } from "../sse.js";
import {
  conversationKey,
  firstUserHashDiagnostics,
  promptCacheKeyFor,
  reasoningItemsByKey,
  reasoningKeyForCallIds,
  setReasoningItemsByKey,
  threadIdFor,
} from "../codex-reasoning-cache.js";
import { markLaneDown, markLaneOk } from "../provider-health.js";
import { runCodexWsTurn } from "./codex-ws.js";
import type {
  AnthropicContentBlock,
  AnthropicMessage,
  AnthropicRequest,
  AnthropicTool,
  AnthropicToolChoice,
  ProviderKey,
  ReasoningLevel,
  ServiceTier,
} from "../types.js";

const OPENAI_API_BASE = "https://api.openai.com/v1";
const CHATGPT_CODEX_BASE = "https://chatgpt.com/backend-api/codex";

const DEFAULT_ORIGINATOR = "codex_cli_rs";
const DEFAULT_CODEX_CLI_VERSION = "0.144.1";
// Tool names whose input schema has already been walked (diagnostic-only; the walk runs
// once per tool name per process). A tool whose schema changes mid-process — e.g. an MCP
// tool re-declared with a new shape — will not be re-inspected; the returned tool objects
// always carry the live schema reference regardless.
const inspectedSchemaTools = new Set<string>();
const payloadWarningSteps = new Map<string, number>();
const PAYLOAD_WARNING_CAP = 512;

// ── CCX_CACHE_DEBUG (exp3 diagnostics, 2026-09-06; default OFF) ──────────────────────────
// Per-request sequence number, wall-clock stamps, the set of requests in flight on the same
// prompt_cache_key, the exact byte offset at which the wire JSON diverges from the previous
// request on that key, and (with CCX_CACHE_DEBUG_DIR) a dump of each inbound Anthropic body
// and outbound Responses body for offline replay. Nothing here runs unless the flag is on.
const cacheDebug = process.env.CCX_CACHE_DEBUG === "1";
const cacheDebugDir = process.env.CCX_CACHE_DEBUG_DIR || "";
let cacheDebugSeq = 0;
const cacheDebugRun = new Date().toISOString().replace(/[-:T]/g, "").slice(4, 12);
const inFlightByKey = new Map<string, Set<number>>();
const lastWireByKey = new Map<string, { seq: number; json: string }>();
export function codexSessionHeadersEnabled(): boolean {
  const v = (process.env.CCX_CODEX_SESSION_HEADERS ?? "").trim().toLowerCase();
  return !(v === "0" || v === "false" || v === "off");
}
function cacheDebugDump(name: string, text: string) {
  if (!cacheDebug || !cacheDebugDir) return;
  try {
    writeFileSync(join(cacheDebugDir, name), text);
  } catch (err) {
    console.log(`[codex] cache-debug dump failed: ${String(err)}`);
  }
}
// Per-conversation record of the previous turn's input-item hashes, for the prefix-stability
// probe at the end of chatCodexOAuthInner. Diagnostic only; never affects the request.
// Keyed on the P0.3 probe key (cc_prompt_id + earliest assistant tool-call id), NOT on
// prompt_cache_key -- that key is shared globally on this host (work order section 4), so
// indexing this map by it made comparisons potentially cross-conversation.
const prefixProbe = new Map<
  string,
  {
    items: string[];
    shell: string;
    instr: string;
    instrNorm: string;
    tools: string;
    instrText: string;
    blocks: SystemBlockSignature[];
  }
>();

// ── Header builders ──────────────────────────────────────────────────

function installationId(): string {
  try {
    return readFileSync(join(homedir(), ".codex", "installation_id"), "utf-8").trim();
  } catch {
    return "";
  }
}

/** Build the User-Agent string Codex CLI sends. Matches `get_codex_user_agent()`. */
function codexUserAgent(): string {
  const version = process.env.CODEX_CLI_VERSION || DEFAULT_CODEX_CLI_VERSION;
  return `${DEFAULT_ORIGINATOR}/${version} (${type()} ${release()}; ${arch()})`;
}

// ── Tool conversion (Anthropic → Responses API) ──────────────────────

type ResponsesTool =
  | {
      type: "function";
      name: string;
      description: string;
      strict: false;
      parameters: unknown;
    }
  | {
      type: "web_search";
      search_context_size?: "low" | "medium" | "high";
    };

export function inspectToolSchema(schema: unknown): { constructs: string[]; maxDepth: number } {
  const found = new Set<string>();
  const visited = new Set<object>();
  let maxDepth = 0;
  const depthCap = 64;
  const namedConstructs = new Set([
    "$ref",
    "anyOf",
    "oneOf",
    "allOf",
    "not",
    "patternProperties",
    "format",
  ]);

  function walk(value: unknown, depth: number) {
    if (value === null || typeof value !== "object") return;
    maxDepth = Math.max(maxDepth, depth);
    if (depth > 5) found.add("depth>5");
    if (depth >= depthCap || visited.has(value)) return;
    // Cycle detection is per path, not global: a sub-schema reachable from two different
    // branches (a DAG) is re-inspected on each branch, while a true cycle still terminates
    // because the node is already on the current path when re-encountered.
    visited.add(value);
    for (const [key, child] of Object.entries(value)) {
      if (namedConstructs.has(key)) found.add(key);
      walk(child, depth + 1);
    }
    visited.delete(value);
  }

  walk(schema, 0);
  return { constructs: [...found].sort(), maxDepth };
}

export function toResponsesTools(tools: AnthropicTool[] | undefined): ResponsesTool[] {
  const out: ResponsesTool[] = [];
  if (tools) {
    for (const t of tools) {
      const schema = t.input_schema ?? { type: "object", properties: {} };
      if (!inspectedSchemaTools.has(t.name)) {
        const { constructs, maxDepth } = inspectToolSchema(schema);
        inspectedSchemaTools.add(t.name);
        if (constructs.length > 0) {
          console.log(`[codex] tool schema note: ${t.name} uses ${constructs.join(", ")} (depth ${maxDepth}) - malformed-args retries on this tool may be schema-caused, not model slippage`);
        }
      }
      out.push({
        type: "function",
        name: t.name,
        description: t.description ?? "",
        strict: false,
        parameters: schema,
      });
    }
  }
  // Codex CLI registers native web_search; Claude Code's WebSearch/WebFetch are stripped
  // upstream in anthropic-gateway.ts before they reach us.
  out.push({ type: "web_search" });
  return out;
}

export function toResponsesToolChoice(c?: AnthropicToolChoice): string | { type: string; name?: string } {
  if (!c || c.type === "auto") return "auto";
  if (c.type === "any") return "required";
  if (c.type === "none") return "none";
  if (c.type === "tool") return { type: "function", name: c.name };
  return "auto";
}

// ── Input conversion (Anthropic messages → Responses ResponseItem[]) ──

type ResponseMessageContent =
  | { type: "input_text"; text: string }
  | { type: "input_image"; image_url: string; detail?: "auto" | "low" | "high" }
  | { type: "output_text"; text: string };

export type ReasoningResponseItem = {
  type: "reasoning";
  summary: Array<{ type: "summary_text"; text: string }>;
  encrypted_content?: string | null;
};

export type ResponseItem =
  | {
      type: "message";
      role: "user" | "assistant" | "system" | "developer";
      content: ResponseMessageContent[];
    }
  | { type: "function_call"; call_id: string; name: string; arguments: string }
  | { type: "function_call_output"; call_id: string; output: string }
  | ReasoningResponseItem;

export function textFromResponsesMessageItem(item: {
  type?: string;
  content?: Array<{ type?: string; text?: string }>;
}): string {
  if (item.type !== "message" || !Array.isArray(item.content)) return "";
  return item.content
    .map((part) => (part.type === "output_text" || part.type === "text" ? part.text || "" : ""))
    .filter(Boolean)
    .join("");
}

function flattenSystem(system: AnthropicRequest["system"]): string {
  if (!system) return "";
  if (typeof system === "string") return system;
  return system
    .map((b) => (typeof b === "string" ? b : (b as { text?: string }).text || ""))
    .filter(Boolean)
    .join("\n");
}

const CLAUDE_COMPACTION_PROMPT_MARKERS = [
  "CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.",
  "Your task is to create a detailed summary of",
];

/** Detect Claude Code's generated compaction turn without affecting user prompts about summaries. */
export function isClaudeCompactionRequest(body: AnthropicRequest): boolean {
  let message: AnthropicMessage | undefined;
  for (let i = body.messages.length - 1; i >= 0; i--) {
    if (body.messages[i].role === "user") {
      message = body.messages[i];
      break;
    }
  }
  if (!message) return false;
  const text = typeof message.content === "string"
    ? message.content
    : message.content
        .filter((block): block is Extract<AnthropicContentBlock, { type: "text" }> => block.type === "text")
        .map((block) => block.text)
        .join("\n");
  return CLAUDE_COMPACTION_PROMPT_MARKERS.every((marker) => text.includes(marker));
}

function previewText(text: string, max = 160): string {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length > max ? `${compact.slice(0, max)}...` : compact;
}

function responseItemSummary(item: ResponseItem | undefined): string {
  if (!item) return "none";
  if (item.type === "message") {
    const text = item.content
      .map((part) => ("text" in part ? part.text : part.image_url ? "[image]" : ""))
      .filter(Boolean)
      .join(" ");
    return `message:${item.role}:${previewText(text)}`;
  }
  if (item.type === "function_call") {
    return `function_call:${item.name}:${item.call_id}`;
  }
  if (item.type === "function_call_output") {
    return `function_call_output:${item.call_id}:${previewText(item.output)}`;
  }
  return `reasoning:encrypted=${item.encrypted_content ? "yes" : "no"} summaries=${item.summary.length}`;
}

function imageUrlForBlock(block: Extract<AnthropicContentBlock, { type: "image" }>): string {
  const s = block.source;
  if (s.type === "base64") return `data:${s.media_type};base64,${s.data}`;
  if (s.type === "url") return s.url;
  return "";
}

function stringifyToolResult(content: string | AnthropicContentBlock[]): string {
  if (typeof content === "string") return content;
  // Anthropic allows tool_result content to be a list of blocks. Codex/OpenAI
  // function_call_output.output is a plain string, so flatten text + JSON-encode the rest.
  return content
    .map((b) => {
      if (b.type === "text") return b.text;
      if (b.type === "image") return `[image: ${(b as { source: { media_type?: string } }).source.media_type || "unknown"}]`;
      return JSON.stringify(b);
    })
    .join("\n");
}

// Codex's ChatGPT backend rejects input items with role "system"
// ({"detail":"System messages are not allowed"}). Claude Code 2.1.156+ sends
// MCP/skill instructions as a role:"system" message inside `messages`, so map any
// non-user/assistant role to "developer" — the Responses API's system-level role.
function toInputRole(role: AnthropicMessage["role"]): "user" | "assistant" | "developer" {
  if (role === "assistant") return "assistant";
  if (role === "user") return "user";
  return "developer";
}

function trailingDeveloperMessageCount(messages: AnthropicMessage[]): number {
  let count = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (toInputRole(messages[i].role) !== "developer") break;
    count += 1;
  }
  return count;
}

export function normalizeMessagesForResponses(messages: AnthropicMessage[]): AnthropicMessage[] {
  const trailingCount = trailingDeveloperMessageCount(messages);
  if (trailingCount === 0 || trailingCount === messages.length) return messages;

  const split = messages.length - trailingCount;
  const finalActionable = messages[split - 1];
  return [
    ...messages.slice(0, split - 1),
    ...messages.slice(split),
    finalActionable,
  ];
}

export function toResponsesInput(
  messages: AnthropicMessage[],
  injectedReasoning: ResponseItem[] = [],
): ResponseItem[] {
  const out: ResponseItem[] = [];
  // Where the cached reasoning gets spliced in, once we know where the last assistant turn
  // starts. -1 until we see one. See the splice below for why this is not simply out[0].
  let lastAssistantStart = -1;

  for (const m of messages) {
    // Provisional: only committed below if this message actually emits items, so an
    // assistant turn carrying nothing but dropped thinking blocks does not move the
    // splice point onto the following user turn's items.
    const startOfThisMessage = out.length;

    if (typeof m.content === "string") {
      out.push({
        type: "message",
        role: toInputRole(m.role),
        content: [
          m.role === "assistant"
            ? { type: "output_text", text: m.content }
            : { type: "input_text", text: m.content },
        ],
      });
      if (m.role === "assistant") lastAssistantStart = startOfThisMessage;
      continue;
    }

    const inlineContent: ResponseMessageContent[] = [];
    const trailingItems: ResponseItem[] = [];
    for (const block of m.content as AnthropicContentBlock[]) {
      switch (block.type) {
        case "text":
          inlineContent.push(
            m.role === "assistant"
              ? { type: "output_text", text: block.text }
              : { type: "input_text", text: block.text },
          );
          break;
        case "image":
          inlineContent.push({ type: "input_image", image_url: imageUrlForBlock(block) });
          break;
        case "tool_use":
          trailingItems.push({
            type: "function_call",
            call_id: block.id,
            name: block.name,
            arguments:
              typeof block.input === "string" ? block.input : JSON.stringify(block.input ?? {}),
          });
          break;
        case "tool_result":
          trailingItems.push({
            type: "function_call_output",
            call_id: block.tool_use_id,
            output: stringifyToolResult(block.content),
          });
          break;
        case "thinking":
        case "redacted_thinking":
          // Claude Code may replay historical Anthropic thinking blocks on every
          // turn. They are not reusable Codex reasoning state; the only reasoning
          // we should echo back is the encrypted_content returned by Responses
          // and stored in our cache. Re-sending thinking summaries here can make
          // long resumed sessions exceed the upstream context window.
          break;
      }
    }

    if (inlineContent.length) {
      out.push({ type: "message", role: toInputRole(m.role), content: inlineContent });
    }
    if (trailingItems.length) out.push(...trailingItems);
    if (m.role === "assistant" && out.length > startOfThisMessage) {
      lastAssistantStart = startOfThisMessage;
    }
  }

  // Encrypted reasoning carries the prior turn's chain of thought. It belongs immediately
  // before the items of the LAST assistant turn -- that is the turn that produced it, so the
  // Responses API sees `reasoning, function_call, function_call_output` in the order Codex
  // itself sends.
  //
  // It must NOT go at out[0]. These blobs are replaced with fresh server output every turn
  // (see setReasoningItems), so a changing item at position 0 invalidates the prompt-cache
  // prefix for the entire input array. That is not theoretical: with the injection at the
  // front, 99.9% of requests read back only the fixed `instructions`+`tools` prefix
  // (cacheRead pinned at 3712/5760 tokens regardless of transcript depth), so the whole
  // conversation was re-prefilled from scratch on every tool call. Combined with
  // `store: false`, that made wall-clock cost quadratic in tool calls -- the reason high
  // reasoning efforts, which take the most turns, were hit hardest.
  //
  // With no assistant turn yet there is no history to keep cacheable and the array is just
  // the opening user turn, so the front is both correct and harmless.
  if (injectedReasoning.length) {
    out.splice(lastAssistantStart === -1 ? 0 : lastAssistantStart, 0, ...injectedReasoning);
  }

  return out;
}

export type ResponsesInputs = {
  /** For the HTTPS path: trailing developer messages moved after the last actionable item. */
  httpInput: ResponseItem[];
  /** For the WS delta path: raw, unreordered -- append-only turn over turn. */
  wsInput: ResponseItem[];
};

/**
 * The one place that decides whether a Codex request's `input` gets the trailing-developer
 * reorder. Fix B (dominant cause of the WS delta transport falling back to a full resend on 91%
 * of production requests): normalizeMessagesForResponses's reorder is defined relative to the
 * END of a growing conversation, so an item's position shifts turn over turn, and a permuted
 * history can never be a strict prefix of what codex-ws.ts recorded as a session's baseline. The
 * HTTPS path re-uploads the whole transcript every turn regardless (`store:false`) and can
 * afford the reorder for prompt-cache-key stability; the WS path cannot, and must see the RAW,
 * unreordered messages instead -- developer/system-reminder messages are replayed in full every
 * turn regardless, so the raw list is already append-only and stable without needing the reorder
 * at all.
 *
 * Both fields are consumed at the one call site in chatCodexOAuthInner, so reverting this choice
 * means changing this function rather than an inline expression a future edit can silently drop.
 *
 * KNOWN TRADE-OFF, and the reason for the escape hatch below. The reorder is not incidental: its
 * own test is named "moves trailing developer context before the final user prompt", i.e. it
 * exists so the model's LAST-read item is the user's actionable task rather than ambient MCP
 * status or a skill listing. Dropping it on the WS path means gpt-5.6 reads the system-reminders
 * last. That is what Claude Code natively sends to Anthropic, so it is not novel, but its effect
 * on instruction-following here is UNMEASURED -- and it would degrade silently, as a slightly
 * worse agent rather than an error. Keeping both properties is not possible: reordering only
 * within the delta puts the permuted tail into history on the following turn, which breaks the
 * strict prefix again, which is the whole bug.
 *
 * So the choice is reversible without a code edit. CCX_CODEX_WS_RAW_ORDER=0 restores the reorder
 * on the WS path, accepting full resends (the pre-fix behaviour) in exchange for actionable-last.
 * Default is raw order, because the cost of the reorder here is measured at 1,993/2,043 turns
 * re-uploading the full transcript and the benefit is not.
 */
export function isWsRawOrderEnabled(): boolean {
  return process.env.CCX_CODEX_WS_RAW_ORDER !== "0";
}

export function buildResponsesInputs(
  messages: AnthropicMessage[],
  cachedReasoning: ResponseItem[],
): ResponsesInputs {
  const reordered = normalizeMessagesForResponses(messages);
  return {
    httpInput: toResponsesInput(reordered, cachedReasoning),
    wsInput: toResponsesInput(isWsRawOrderEnabled() ? messages : reordered, []),
  };
}

// ── Reasoning effort mapping ─────────────────────────────────────────

function reasoningEffort(level?: ReasoningLevel): "low" | "medium" | "high" | "xhigh" | "max" {
  if (level === "none" || level === "minimal") return "low"; // Codex has no thinking-off; floor to low
  if (level) return level; // low | medium | high | xhigh | max pass straight through
  // Codex maps its client-only "ultra" effort to "max" on the wire (multi-agent
  // orchestration is a CLI concern, not a Responses param), so "max" is the ceiling
  // the proxy ever sends. GPT-5.6 Sol/Terra/Luna accept it; older models cap at xhigh.
  const env = (process.env.CODEX_REASONING_EFFORT || "").toLowerCase();
  if (env === "low" || env === "medium" || env === "high" || env === "xhigh" || env === "max") return env;
  return "high";
}

export function effectiveReasoningEffort(
  body: AnthropicRequest,
  level?: ReasoningLevel,
): "low" | "medium" | "high" | "xhigh" | "max" {
  const effort = reasoningEffort(level);
  if (!isClaudeCompactionRequest(body)) return effort;
  return effort === "low" || effort === "medium" ? effort : "medium";
}

function reasoningSummary(): "auto" | "concise" | "detailed" | null {
  const env = (process.env.CODEX_REASONING_SUMMARY || "").toLowerCase();
  if (env === "concise" || env === "detailed" || env === "auto") return env;
  if (env === "none") return null;
  return "auto";
}

function textVerbosity(): "low" | "medium" | "high" | undefined {
  const env = (process.env.CODEX_TEXT_VERBOSITY || "").toLowerCase();
  if (env === "low" || env === "medium" || env === "high") return env;
  return undefined;
}

// ── Phase 0 diagnostics & B1/B2 key helpers ───────────────────────────
//
// Everything in this section is either read-only (diagnostics) or a pure key derivation. None
// of it mutates `instructions`, `input`, or any outgoing request field.

export type SystemBlockSignature = { index: number; type: string; len: number; hash: string };

/**
 * Raw per-block signatures of body.system, for P0.2's per-block diff. Deliberately reads the
 * unflattened blocks rather than flattenSystem's joined string (flattenSystem joins non-empty
 * block texts with a single newline, above) so an inserted/removed block shows up as an
 * array-length change instead of being smeared into one long string offset.
 */
function systemBlocksOf(system: AnthropicRequest["system"]): SystemBlockSignature[] {
  if (!system) return [];
  const raw = typeof system === "string"
    ? [{ type: "string", text: system }]
    : system.map((b) =>
        typeof b === "string"
          ? { type: "string", text: b }
          : { type: (b as { type?: string }).type || "text", text: (b as { text?: string }).text || "" },
      );
  return raw.map((b, index) => ({
    index,
    type: b.type,
    len: b.text.length,
    hash: createHash("sha1").update(b.text).digest("hex").slice(0, 12),
  }));
}

/**
 * P0.2a: report every changed block signature, not just the first differing offset. `cch`
 * changes on 100% of requests and sits at char 85, so a single-offset view can never see past
 * it -- including the unexplained 1,432-char systemChars swing (work order section 2). Matches
 * blocks by exact hash first (so an unchanged block that merely shifted position is not
 * reported as churn), then treats same-index same-type leftovers as EITHER a size change or a
 * same-length content change, and whatever remains as a pure add or remove.
 *
 * The size/content split matters: a live trace produced `CHANGED-SIZE idx=0 ... lenPrev=153
 * lenNow=153 ...` -- identical lengths, only the hash moved. Labeling that a size change
 * actively misleads the next reader trying to classify the unexplained 1,432-char systemChars
 * swing (work order section 2) from this output, since distinguishing "a block's length moved"
 * from "a same-length block's content moved" is exactly what P0.2 exists to do.
 */
export function diffBlockSignatures(prev: SystemBlockSignature[], curr: SystemBlockSignature[]): string[] {
  const changes: string[] = [];
  const usedPrev = new Set<number>();
  const usedCurr = new Set<number>();
  for (let ci = 0; ci < curr.length; ci++) {
    const pi = prev.findIndex((p, idx) => !usedPrev.has(idx) && p.hash === curr[ci].hash);
    if (pi !== -1) {
      usedPrev.add(pi);
      usedCurr.add(ci);
    }
  }
  for (let i = 0; i < Math.max(prev.length, curr.length); i++) {
    const p = !usedPrev.has(i) ? prev[i] : undefined;
    const c = !usedCurr.has(i) ? curr[i] : undefined;
    if (p && c && p.type === c.type) {
      const label = p.len !== c.len ? "CHANGED-SIZE" : "CHANGED-CONTENT";
      changes.push(`${label} idx=${i} type=${c.type} lenPrev=${p.len} lenNow=${c.len} hashPrev=${p.hash} hashNow=${c.hash}`);
      usedPrev.add(i);
      usedCurr.add(i);
    }
  }
  for (let i = 0; i < prev.length; i++) {
    if (!usedPrev.has(i)) changes.push(`REMOVED idx=${i} type=${prev[i].type} len=${prev[i].len} hash=${prev[i].hash}`);
  }
  for (let i = 0; i < curr.length; i++) {
    if (!usedCurr.has(i)) changes.push(`ADDED idx=${i} type=${curr[i].type} len=${curr[i].len} hash=${curr[i].hash}`);
  }
  return changes;
}

/**
 * P0.2b: a diagnostic-only hash of `instructions` with every `cch=<5 hex>` occurrence replaced
 * by a fixed constant. This NEVER touches the outgoing `instructions` string -- it exists only
 * so the trace can see whether instability survives once the 100%-divergent cch stamp is
 * masked out of the comparison. This is emphatically NOT fix A: work order section 6 defers
 * that pending this very measurement, and nothing here rewrites what gets sent.
 */
function cchNormalizedHash(instructions: string): string {
  return createHash("sha1")
    .update(instructions.replace(/cch=[0-9a-f]{5}/g, "cch=00000"))
    .digest("hex")
    .slice(0, 12);
}

// Module-level, not per-request: work order section 6 requires this to fire once per PROCESS,
// so a sustained format mismatch cannot flood the log with one line per turn.
let cchNormalizeUnexpectedLogged = false;

/**
 * Fix A (work order section 6), NARROW and originally default-OFF behind CCX_NORMALIZE_CCH=1,
 * promoted to DEFAULT-ON 2026-09-06 on the strength of the ad-hoc-enabled measurement: with
 * CCX_NORMALIZE_CCH=1 set in the running proxy's process environment, codex prompt-cache reads
 * reached 142,976 tokens, versus a `cacheRead` that never exceeded 5,760 across the 400 requests
 * before it was enabled -- and no launcher (not start-proxy.cmd, not anything under bin/) ever
 * set that variable, so every ordinary restart was silently reverting the biggest cache win
 * measured so far. This is a separate, deliberately narrower function from `cchNormalizedHash`
 * above: that one is diagnostic-only and does a GLOBAL replace over the whole `instructions`
 * string, which is fine feeding a hash used only in a log line, but would be wrong on the wire --
 * it would rewrite a `cch=abcde`-shaped substring appearing in user-authored text. This function
 * instead locates the single recognized Claude Code metadata line -- identified, per the
 * confirmed shape from the live trace, by containing BOTH `cc_version=` and `cc_prompt_id=` --
 * and replaces exactly one `cch=[0-9a-f]{5}` within THAT line only, with a same-width constant so
 * `instructions.length` stays comparable whether or not the flag is on. Every other line,
 * including all user-authored text, passes through byte-identical. If the metadata line is
 * missing, or contains zero or more than one `cch` field, the format has moved out from under
 * this function's assumption: log it once per process (see the flag above -- once per REQUEST
 * would flood the log under sustained churn) and return the input completely unchanged, so a
 * format change surfaces as loud, unnormalized churn rather than being silently absorbed back
 * into the old behaviour.
 */
export function normalizeCchForWire(instructions: string): string {
  const lines = instructions.split("\n");
  const lineIndex = lines.findIndex((line) => line.includes("cc_version=") && line.includes("cc_prompt_id="));
  if (lineIndex === -1) return instructions;
  const line = lines[lineIndex];
  const matches = line.match(/cch=[0-9a-f]{5}/g) ?? [];
  if (matches.length !== 1) {
    if (!cchNormalizeUnexpectedLogged) {
      cchNormalizeUnexpectedLogged = true;
      console.log(`[codex] cch-normalize UNEXPECTED count=${matches.length}`);
    }
    return instructions;
  }
  lines[lineIndex] = line.replace(/cch=[0-9a-f]{5}/, "cch=00000");
  return lines.join("\n");
}

/**
 * Fix A's env gate, kept as its own function so the request path and the test suite share
 * exactly one place that decides whether the normalizer ever touches what actually goes on the
 * wire. Default ON as of 2026-09-06 (see `cchNormalizedForWire`'s doc comment above for the
 * measurement behind the promotion); `CCX_NORMALIZE_CCH=0` (also accepting "false"/"off",
 * case-insensitive) is kept as an opt-out so this can be reverted with an env var alone if a
 * future measurement calls for it, mirroring `isPromptCacheKeyV2Enabled` below. `normalized`
 * is true only when normalization is enabled AND a replacement actually happened -- distinct
 * from "enabled but the line was malformed and nothing changed" -- so p0-correlate's
 * `cchNormalized` field means exactly what work order section 6's attribution requirement asks
 * for.
 */
export function isCchNormalizeEnabled(): boolean {
  const raw = process.env.CCX_NORMALIZE_CCH;
  if (raw === undefined) return true;
  return !["0", "false", "off"].includes(raw.toLowerCase());
}

export function cchNormalizedForWire(instructions: string): { sent: string; normalized: boolean } {
  if (!isCchNormalizeEnabled()) {
    return { sent: instructions, normalized: false };
  }
  const sent = normalizeCchForWire(instructions);
  return { sent, normalized: sent !== instructions };
}

/**
 * B1 (work order section 4), promoted to DEFAULT-ON 2026-09-05 on the strength of the 86/86
 * firstUserStrippedHash stability result (see the call site's comment for the full trace
 * description). Kept as its own function, rather than an inline `=== "1"` check, both because
 * the accepted disable spellings are now more than one string and so this exact decision is
 * unit-testable without going through the network-calling request path.
 */
export function isPromptCacheKeyV2Enabled(): boolean {
  const raw = process.env.CCX_PROMPT_CACHE_KEY_V2;
  if (raw === undefined) return true;
  return !["0", "false", "off"].includes(raw.toLowerCase());
}

/** First tool_use id on the earliest assistant turn that has one. Used only to narrow the
 * P0.3 probe key when cc_prompt_id (below) is unavailable or to further split fan-out
 * siblings that happen to share one. */
function earliestAssistantToolCallId(messages: AnthropicMessage[]): string | null {
  for (const m of messages) {
    if (m.role !== "assistant" || typeof m.content === "string") continue;
    const toolUse = (m.content as AnthropicContentBlock[]).find(
      (b): b is Extract<AnthropicContentBlock, { type: "tool_use" }> => b.type === "tool_use",
    );
    if (toolUse) return toolUse.id;
  }
  return null;
}

/**
 * P0.3: prefix-probe and shell-probe used to be keyed on prompt_cache_key, which section 4
 * proves is shared globally on this host (input-item counts falling from 58 to 26 prove
 * distinct conversations collided under it). Re-key on the stable per-conversation
 * `cc_prompt_id` parsed out of the Claude Code metadata line, combined with the earliest
 * assistant tool-call id present. When cc_prompt_id cannot be found, fall back to the
 * tool-call id alone, or a single shared bucket, and mark the entry DEGRADED so a
 * contaminated comparison can never again be mistaken for a clean, single-conversation one.
 */
function probeKeyFor(instructions: string, messages: AnthropicMessage[]): { key: string; degraded: boolean } {
  const promptIdMatch = /cc_prompt_id=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/.exec(
    instructions,
  );
  const toolCallId = earliestAssistantToolCallId(messages);
  if (promptIdMatch) {
    return { key: `pid:${promptIdMatch[1]}${toolCallId ? `:${toolCallId}` : ""}`, degraded: false };
  }
  return { key: toolCallId ? `tc-only:${toolCallId}` : "shared:no-prompt-id", degraded: true };
}

/**
 * B2 request-side key: the tool-call id tuple emitted by the LAST assistant turn, which is the
 * turn whose reasoning gets spliced immediately before it (see toResponsesInput). A text-only
 * last assistant turn yields an empty tuple; reasoningKeyForCallIds turns that into `null`,
 * which the caller reads as "skip reasoning reuse for this transition" (work order section 5:
 * "correctness outranks reuse").
 */
function lastAssistantToolCallIds(messages: AnthropicMessage[]): string[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role !== "assistant") continue;
    const content = messages[i].content;
    if (typeof content === "string") return [];
    return (content as AnthropicContentBlock[])
      .filter((b): b is Extract<AnthropicContentBlock, { type: "tool_use" }> => b.type === "tool_use")
      .map((b) => b.id);
  }
  return [];
}

/** P0.6: assistant turns mid-conversation with no tool_use block. B2 forfeits reasoning reuse
 * on exactly these transitions (section 5), so this measures the size of that forfeit instead
 * of assuming it. */
function countTextOnlyAssistantTurns(messages: AnthropicMessage[]): number {
  let count = 0;
  for (const m of messages) {
    if (m.role !== "assistant") continue;
    const hasToolUse =
      typeof m.content !== "string" && (m.content as AnthropicContentBlock[]).some((b) => b.type === "tool_use");
    if (!hasToolUse) count += 1;
  }
  return count;
}

// ── Main adapter ─────────────────────────────────────────────────────

// ── Fast mode (service_tier) ─────────────────────────────────────────
//
// Which models accept a service tier, read off the account's own catalog at
// ~/.codex/models_cache.json (`service_tiers: [{id:"priority", name:"Fast"}]`). Every
// GPT-5.6 variant, plus 5.5 and 5.4, carry it; `gpt-5.4-mini` carries an empty list, which
// is the reason this is a check and not an assumption.
//
// Matched on prefix so a dated snapshot ("gpt-5.6-sol-2026-08-01") inherits its family. A
// model missing from the table is left at standard rather than guessed into fast mode: the
// downside of a wrong guess is an upstream 400 on every request from that slot, against a
// saving of one line in this table when a new model ships.
const SERVICE_TIER_MODELS = ["gpt-5.6", "gpt-5.5", "gpt-5.4"];

function supportsServiceTier(model: string): boolean {
  const lc = model.toLowerCase();
  if (lc.startsWith("gpt-5.4-mini")) return false; // catalog lists service_tiers: []
  return SERVICE_TIER_MODELS.some((m) => lc.startsWith(m));
}

// ── Lane health ───────────────────────────────────────────────────────
//
// See provider-health.ts for what "definitive" means and why a single timeout must not
// reach markLaneDown. The two paths below are the codex-specific half of that contract.

/**
 * A non-2xx Responses-API reply. Only two shapes here are definitive enough to flip the lane
 * down; everything else (a plain 500, an unrecognised 4xx) is left alone, because guessing
 * wrong here means the lane looks down when it is merely having a bad request.
 *
 * The exact wire spelling of the 5-hour usage-limit response is not pinned to one string
 * across ChatGPT-backend snapshots, so this matches on the status code plus the vocabulary
 * every variant observed uses, rather than one exact phrase.
 */
function classifyCodexUpstreamError(status: number, text: string): string | null {
  const lc = text.toLowerCase();
  if (status === 429 && /usage.?limit|rate.?limit|quota|too many requests/.test(lc)) {
    return "codex-quota";
  }
  if ((status === 401 || status === 403) && /token|auth|unauthorized|expired|invalid_grant/.test(lc)) {
    return "codex-auth";
  }
  return null;
}

/**
 * Same job as classifyCodexUpstreamError, for a hard failure delivered INSIDE an
 * otherwise-200 SSE stream (`response.failed` / `response.incomplete`). There is no status
 * code at this point - the HTTP response already succeeded - so the match leans on the same
 * vocabulary alone.
 */
function classifyCodexStreamFailure(text: string): string | null {
  const lc = text.toLowerCase();
  if (/usage.?limit|rate.?limit|quota|too many requests/.test(lc)) return "codex-quota";
  // No status code is available at this point (see doc comment above), so this leans on
  // vocabulary alone - and a bare "token" is too broad: `incomplete_details.reason` for an
  // ordinary max-output-token truncation is literally "max_output_tokens", and a
  // context-window-overflow error message routinely says "... exceeds the context window of
  // N tokens." Neither is an auth failure. Require actual auth vocabulary instead.
  if (/auth|unauthorized|expired|invalid_grant/.test(lc)) return "codex-auth";
  return null;
}

/**
 * getCodexAccessToken() throws for two different reasons under one wrapper message,
 * "OpenAI token refresh failed: <cause>. Please re-login with claude-codex." - and only one
 * of them is unrecoverable. When refreshAccessToken() got a real HTTP response back and the
 * server rejected it, that response's own message embeds "(<status>)"; when the fetch never
 * completed (a network blip mid-refresh), <cause> is a bare error like "fetch failed" with no
 * status. Only the former means a retry cannot fix this without the user re-authenticating -
 * the latter must NOT flip the lane down on one sample.
 *
 * A real HTTP response is not automatically unrecoverable either: refreshAccessToken() embeds
 * whatever status the token endpoint returned, and a transient 429/500/503 there is the same
 * "try again shortly" signal as any other transient upstream error - only a 400/401/403 means
 * the server rejected the credentials themselves.
 */
function isCodexAuthUnrecoverable(message: string): boolean {
  if (/not logged in to openai/i.test(message)) return true;
  const m = /token refresh failed \((\d+)\)/i.exec(message);
  if (!m) return false;
  const status = Number(m[1]);
  return status === 400 || status === 401 || status === 403;
}

export async function chatCodexOAuth(
  res: FastifyReply,
  body: AnthropicRequest,
  model: string,
  apiKey?: string,
  reasoning?: ReasoningLevel,
  serviceTier?: ServiceTier,
) {
  try {
    await chatCodexOAuthInner(res, body, model, apiKey, reasoning, serviceTier);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[codex] ERROR: ${message}`);
    emitErrorAsSse(res, model, message);
  }
}

function emitErrorAsSse(res: FastifyReply, model: string, message: string) {
  if (res.raw.writableEnded) return;
  try {
    const id = `msg_${Date.now()}`;
    sendEvent(res, "message_start", {
      type: "message_start",
      message: {
        id,
        type: "message",
        role: "assistant",
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    });
    sendEvent(res, "content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    });
    sendEvent(res, "content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: `[codex proxy error] ${message}` },
    });
    sendEvent(res, "content_block_stop", { type: "content_block_stop", index: 0 });
    sendEvent(res, "message_delta", {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 0 },
    });
    sendEvent(res, "message_stop", { type: "message_stop" });
    res.raw.end();
  } catch {
    /* stream already closed */
  }
}

// undici wraps every connection-level failure as a bare `TypeError: fetch failed`,
// hiding the real reason (ECONNRESET from a stale keep-alive socket, connect
// timeout, DNS blip). Unwrap `.cause` so logs and the surfaced error say why.
function describeFetchError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const cause = (err as { cause?: unknown }).cause;
  if (cause instanceof Error) {
    const code = (cause as { code?: string }).code;
    return code ? `${err.message} (${code})` : `${err.message} (${cause.message})`;
  }
  return err.message;
}

// `fetch()` only throws on connection-level failures — an HTTP error status comes
// back as a resolved Response — so a throw means the request never reached the
// server and re-POSTing the identical body is safe (Codex requests use store:false).
// The dominant cause is a pooled keep-alive socket the backend already closed;
// the failing attempt errors instantly and the retry gets a fresh connection.
async function fetchCodexWithRetry(
  url: string,
  init: RequestInit,
  attempts = 3,
): Promise<Response> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fetch(url, init);
    } catch (err) {
      lastErr = err;
      if (attempt < attempts) {
        const backoffMs = 250 * attempt;
        console.error(
          `[codex] upstream connect failed (attempt ${attempt}/${attempts}): ${describeFetchError(err)} — retrying in ${backoffMs}ms`,
        );
        await new Promise((r) => setTimeout(r, backoffMs));
      }
    }
  }
  throw new Error(describeFetchError(lastErr));
}

async function chatCodexOAuthInner(
  res: FastifyReply,
  body: AnthropicRequest,
  model: string,
  apiKey?: string,
  reasoning?: ReasoningLevel,
  serviceTier?: ServiceTier,
) {
  const isOAuth = !apiKey;
  // "openai" and "codex-oauth" are two different aliases over the same adapter (API key vs
  // ChatGPT OAuth), and they fail independently - an OAuth quota hit says nothing about
  // whether the API-key lane still has budget. Health is tracked per lane, not per adapter.
  const lane: ProviderKey = isOAuth ? "codex-oauth" : "openai";
  let accessToken: string;
  try {
    accessToken = apiKey ?? (await getCodexAccessToken());
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (isCodexAuthUnrecoverable(message)) markLaneDown(lane, "auth-expired", message);
    throw err;
  }
  const url = isOAuth
    ? `${CHATGPT_CODEX_BASE}/responses`
    : `${OPENAI_API_BASE}/responses`;

  const messages = normalizeMessagesForResponses(body.messages);
  const trailingDeveloperMoved = messages === body.messages ? 0 : trailingDeveloperMessageCount(body.messages);

  // B1 (work order section 4), promoted to DEFAULT-ON 2026-09-05: an isolated 86-request trace
  // (single conversation, nothing else on the codex lane) found firstUserStrippedHash identical
  // on 86/86 requests, INCLUDING a genuine ordinary follow-up user turn and not just tool-result
  // turns -- the exact stability P0.4 was gating this promotion on. prompt_cache_key affinity is
  // still split from reasoning identity (B2, below), and both the legacy and v2 candidates are
  // still computed and logged on every request regardless of the flag, so the comparison this
  // promotion was decided from keeps being reproducible after the flip. An explicit opt-out
  // (CCX_PROMPT_CACHE_KEY_V2=0, also accepting "false"/"off") is kept so this can be reverted
  // without a redeploy if a wider population disagrees with the 86-request sample.
  const convoKey = conversationKey(messages);
  const promptCacheKeyV2Candidate = promptCacheKeyFor(messages);
  const usePromptCacheKeyV2 = isPromptCacheKeyV2Enabled();
  const promptCacheKey = threadIdFor(usePromptCacheKeyV2 ? promptCacheKeyV2Candidate : convoKey);

  // B2 (not gated; correctness): reasoning identity is the LAST assistant turn's tool-call id
  // tuple, never a first-user hash -- that is what stops one conversation's encrypted
  // chain-of-thought from being injected into another's request (work order section 5). A
  // text-only last assistant turn yields an empty tuple, reasoningKeyForCallIds returns null,
  // and reuse is skipped outright rather than guessed at.
  const reasoningCacheDisabled = process.env.CCX_DISABLE_REASONING_CACHE === "1";
  const reasoningLookupKey = reasoningKeyForCallIds(lastAssistantToolCallIds(messages));
  const reasoningReuseSkipped = reasoningLookupKey === null;
  const cachedReasoning = reasoningCacheDisabled || !reasoningLookupKey
    ? []
    : (reasoningItemsByKey(reasoningLookupKey) as ResponseItem[]);

  // The WebSocket transport carries the previous turn's chain of thought in the server's own
  // connection-local state, so the local encrypted-reasoning cache must NOT be spliced into
  // anything sent there. Two reasons, and the second is the load-bearing one. The server
  // already has it, so re-sending is waste; and the delta calculation in codex-ws.ts compares
  // this turn's items against what was sent last turn, which only lines up if neither array
  // carries an item the client would never echo back. See the Baseline note in that file.
  //
  // Fix B (dominant cause, 91% of requests): see buildResponsesInputs's doc comment. `input`
  // still goes through the reordered messages exactly as before; `inputForWs` is now built by
  // the same function that builds `input`, so the two can never drift apart again silently.
  const { httpInput: input, wsInput: inputForWs } = buildResponsesInputs(body.messages, cachedReasoning);
  const tools = toResponsesTools(body.tools);
  const verbosity = textVerbosity();
  const summary = reasoningSummary();
  const instructions = flattenSystem(body.system);
  const isCompaction = isClaudeCompactionRequest(body);
  const effectiveEffort = effectiveReasoningEffort(body, reasoning);

  // Fix A (work order section 6), NARROW, promoted to DEFAULT-ON 2026-09-06 (see
  // cchNormalizedForWire's doc comment above for the measurement behind the promotion);
  // CCX_NORMALIZE_CCH=0 opts back out. `instructions` above stays exactly what Claude Code sent
  // -- every diagnostic and probe keyed off it below (and rawInstrHash in p0-correlate) must
  // keep seeing the real, unnormalized value so cch churn stays visible even with normalization
  // enabled. `sentInstructions` is the only thing that reaches the wire; see
  // cchNormalizedForWire's and normalizeCchForWire's doc comments above for the gate and for why
  // this is a different, narrower function from the diagnostic-only cchNormalizedHash.
  const { sent: sentInstructions, normalized: cchNormalized } = cchNormalizedForWire(instructions);

  // ── Build request body (matches ResponsesApiRequest in codex-rs/codex-api/src/common.rs) ──
  const reqBody: Record<string, unknown> = {
    model,
    instructions: sentInstructions,
    input,
    tools,
    tool_choice: toResponsesToolChoice(body.tool_choice),
    // A1 (room .room-luna-latency, 2026-09-05): default-off, opt-in via CCX_PARALLEL_TOOL_CALLS=1
    // for the paired A/B. No correctness reason for false was found; see plan.md H1.
    parallel_tool_calls: process.env.CCX_PARALLEL_TOOL_CALLS === "1",
    reasoning: { effort: effectiveEffort, ...(summary ? { summary } : {}) },
    store: false,
    stream: true,
    include: ["reasoning.encrypted_content"],
    prompt_cache_key: promptCacheKey,
  };
  if (verbosity) reqBody.text = { verbosity };

  // P0.5 backend canary (CCX_CACHE_DIAG_CANARY, default OFF). `prompt_cache_diagnostics` is a
  // round-1 room member's citation from developers.openai.com about the Responses API shape --
  // a claim about a document, not a proven property of the ChatGPT backend this proxy talks
  // to, and the member could not fetch the page to confirm it. An unrecognised top-level field
  // can draw an upstream 400, so this stays off by default; when it is on, both the
  // request-acceptance log below and the response-side field check in response.completed log
  // explicitly, including a negative result, so the claim gets resolved instead of assumed.
  const cacheDiagCanary = process.env.CCX_CACHE_DIAG_CANARY === "1";
  if (cacheDiagCanary) {
    reqBody.prompt_cache_diagnostics = true;
  }

  // Fast mode. `service_tier` is a top-level Responses field, sitting between `include` and
  // `prompt_cache_key` in the CLI's own ResponsesApiRequest — both of which are already
  // above, so this needs no new plumbing beyond the value.
  //
  // It applies on BOTH lanes and means something different on each: on the ChatGPT
  // subscription lane it is a credit multiplier (1.5x speed, 2.5x credits on GPT-5.6), and on
  // an API key it is the priority billing rate. Neither is free, which is why nothing here
  // turns it on by default -- it arrives only from an explicit !fast marker on the alias.
  const tierApplied = serviceTier && supportsServiceTier(model);
  if (tierApplied) {
    reqBody.service_tier = serviceTier;
  } else if (serviceTier) {
    // Asked for and refused. Silence here would leave a slot whose alias says !fast running
    // at standard speed with nothing to show the difference -- the failure mode CLAUDE.md
    // calls out as the expensive one, since the user has no way to tell it from a fast
    // request that simply was not faster.
    console.log(`[codex] service_tier=${serviceTier} DROPPED - "${model}" lists no service tiers in the model catalog; sending standard`);
  }

  const installId = installationId();
  if (installId) {
    reqBody.client_metadata = { "x-codex-installation-id": installId };
  }

  // ── Headers ──
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
    Accept: "text/event-stream",
    originator: DEFAULT_ORIGINATOR,
    "User-Agent": codexUserAgent(),
    "OpenAI-Beta": "responses=experimental",
  };
  if (installId) headers["x-codex-installation-id"] = installId;
  // Prompt-cache affinity (exp3, 2026-09-06). Codex CLI sends `conversation_id` and
  // `session_id` headers carrying the same UUID it uses as `prompt_cache_key`
  // (codex-rs/core/src/client.rs). Measured on the rig without them: six byte-identical
  // sequential requests on one prompt_cache_key returned cacheRead 3712, 44672, 5760, 44672,
  // 5760, 44672 -- the backend routed alternate requests to replicas that had never seen the
  // prefix, so prompt_cache_key alone buys no routing affinity on the ChatGPT lane. Opt out
  // with CCX_CODEX_SESSION_HEADERS=0.
  const sessionHeaders = codexSessionHeadersEnabled();
  if (sessionHeaders) {
    headers["conversation_id"] = promptCacheKey;
    headers["session_id"] = promptCacheKey;
  }
  if (isOAuth) {
    const accountId = getCodexAccountId();
    if (accountId) headers["ChatGPT-Account-ID"] = accountId;
  }

  const reqJson = JSON.stringify(reqBody);
  const kib = Math.ceil(Buffer.byteLength(reqJson, "utf8") / 1024);
  const warningStep = Math.floor(kib / 128) * 128;
  const lastWarningStep = payloadWarningSteps.get(promptCacheKey) ?? 0;
  if (kib >= 256 && warningStep > lastWarningStep) {
    console.log(`[codex] payload ${kib} KiB (store:false re-uploads full history every turn) - long-lived leaf; consider retiring and respawning it`);
    payloadWarningSteps.set(promptCacheKey, warningStep);
    // One permanent entry per conversation that ever sent a >=256 KiB request; cap it by
    // dropping oldest-inserted keys (Map preserves insertion order). No work when under the cap.
    while (payloadWarningSteps.size > PAYLOAD_WARNING_CAP) {
      payloadWarningSteps.delete(payloadWarningSteps.keys().next().value as string);
    }
  }
  const reasoningInputCount = input.filter((item) => item.type === "reasoning").length;
  const functionCallCount = input.filter((item) => item.type === "function_call").length;
  const functionOutputCount = input.filter((item) => item.type === "function_call_output").length;
  const lastInput = responseItemSummary(input.at(-1));

  // P0.3: re-keyed off cc_prompt_id + earliest assistant tool-call id instead of
  // prompt_cache_key. See probeKeyFor's doc comment for why and the DEGRADED fallback.
  const { key: probeKey, degraded: probeKeyDegraded } = probeKeyFor(instructions, messages);

  // ── Prefix-stability probe ──
  // The upstream prompt cache matches on an exact prefix, so what it can reuse is decided by
  // the FIRST item that differs from the previous turn -- not by how much of the transcript is
  // unchanged overall. Report that divergence point directly: guessing at it from cacheRead
  // alone cannot distinguish "our prefix moved" from "the server declined to cache".
  // `instructions` and `tools` sit outside `input` and are reported separately, since a change
  // there invalidates everything regardless of what `input` does.
  let instrHash = "";
  let toolsHash = "";
  let instrNormHash = "";
  let sentInstrHash = "";
  {
    const itemHashes = input.map((item) =>
      createHash("sha1").update(JSON.stringify(item)).digest("hex").slice(0, 12),
    );
    const shellHash = createHash("sha1")
      .update(JSON.stringify({ instructions, tools, model, effort: effectiveEffort }))
      .digest("hex")
      .slice(0, 12);
    // `instructions` and `tools` are sent ahead of `input`, so a change in either invalidates
    // the whole cached prefix no matter how stable `input` is. Attribute the change to one of
    // them, and for instructions report the exact offset where it diverges.
    instrHash = createHash("sha1").update(instructions).digest("hex").slice(0, 12);
    toolsHash = createHash("sha1").update(JSON.stringify(tools)).digest("hex").slice(0, 12);
    // P0.2b: diagnostic-only cch-normalized hash, side by side with the raw one. Never mutates
    // `instructions` -- see cchNormalizedHash's doc comment.
    instrNormHash = cchNormalizedHash(instructions);
    // Fix A attribution (work order section 6): `instrHash` above is rawInstrHash and must stay
    // hashing what Claude Code actually sent. `sentInstrHash` is the hash of what actually went
    // on the wire (sentInstructions) -- with CCX_NORMALIZE_CCH=1 the expected pair is
    // rawInstrHash varying per request while sentInstrHash stays constant; without recording
    // both separately that result is unattributable.
    sentInstrHash = createHash("sha1").update(sentInstructions).digest("hex").slice(0, 12);
    const blocks = systemBlocksOf(body.system);
    const priorShell = prefixProbe.get(probeKey);
    if (priorShell && (priorShell.instr !== instrHash || priorShell.tools !== toolsHash)) {
      let at = 0;
      const prevText = priorShell.instrText;
      while (at < instructions.length && at < prevText.length && instructions[at] === prevText[at]) at += 1;
      console.log(
        `[codex] shell-probe key=${probeKey}${probeKeyDegraded ? " DEGRADED" : ""} instructions=${priorShell.instr !== instrHash ? "CHANGED" : "same"} tools=${priorShell.tools !== toolsHash ? "CHANGED" : "same"} lenNow=${instructions.length} lenPrev=${prevText.length} divergeAt=${at} instrHash=${instrHash} instrNormHash=${instrNormHash} normChanged=${priorShell.instrNorm !== instrNormHash} prevAround=${JSON.stringify(prevText.slice(Math.max(0, at - 60), at + 120))} nowAround=${JSON.stringify(instructions.slice(Math.max(0, at - 60), at + 120))}`,
      );
      // P0.2a: every changed block signature, not just the first differing character -- this
      // is what classifies the unexplained 1,432-char systemChars swing (insert/remove of a
      // ~1,431-char block vs. an existing block changing size).
      const blockChanges = diffBlockSignatures(priorShell.blocks, blocks);
      console.log(
        `[codex] shell-probe-blocks key=${probeKey} ${blockChanges.length ? blockChanges.join(" | ") : "no block added/removed/resized - divergence is within an unchanged block count"}`,
      );
    }
    const prior = prefixProbe.get(probeKey);
    if (prior) {
      let same = 0;
      while (same < itemHashes.length && same < prior.items.length && itemHashes[same] === prior.items[same]) {
        same += 1;
      }
      const stableChars = input
        .slice(0, same)
        .reduce((n, item) => n + JSON.stringify(item).length, 0);
      const totalChars = reqJson.length;
      console.log(
        `[codex] prefix-probe key=${probeKey}${probeKeyDegraded ? " DEGRADED" : ""} shell=${shellHash === prior.shell ? "same" : "CHANGED"} stableItems=${same}/${prior.items.length} (now ${itemHashes.length}) stableChars=${stableChars} of ${totalChars} (${((100 * stableChars) / totalChars).toFixed(1)}%) firstDiff=${same < prior.items.length ? responseItemSummary(input[same]) : "none"}`,
      );
    }
    prefixProbe.set(probeKey, {
      items: itemHashes,
      shell: shellHash,
      instr: instrHash,
      instrNorm: instrNormHash,
      tools: toolsHash,
      instrText: instructions,
      blocks,
    });
    while (prefixProbe.size > PAYLOAD_WARNING_CAP) {
      prefixProbe.delete(prefixProbe.keys().next().value as string);
    }
  }

  // P0.4: first-user-message stability, raw vs. reminder-stripped. Hashes and lengths only,
  // never contents -- this is the measurement that gates B1 (work order section 4).
  const firstUserDiag = firstUserHashDiagnostics(messages);
  // P0.6: assistant turns mid-conversation with no tool_use block. B2 forfeits reasoning reuse
  // on exactly these transitions (section 5), so this measures the forfeit's size.
  const textOnlyAssistantTurns = countTextOnlyAssistantTurns(messages);

  console.log(
    `[codex] ${isOAuth ? "ChatGPT" : "API"} | model="${model}" messages=${messages.length} systemChars=${instructions.length} items=${input.length} tools=${tools.length} reasoning=${effectiveEffort}${tierApplied ? ` service_tier=${serviceTier}` : ""}${isCompaction ? " compaction=1" : ""} cache=${cachedReasoning.length}${reasoningCacheDisabled ? " cacheDisabled=1" : ""}${reasoningReuseSkipped ? " reasoningReuseSkipped=1" : ""} movedTrailingDeveloper=${trailingDeveloperMoved} reqKiB=${(reqJson.length / 1024).toFixed(1)} reasoningItems=${reasoningInputCount} fnCalls=${functionCallCount} fnOutputs=${functionOutputCount} textOnlyAssistantTurns=${textOnlyAssistantTurns} last=${JSON.stringify(lastInput)}`,
  );

  // P0.5: carried through to finalize() so the correlate line can join request-side state
  // with cacheRead, which is only known at stream end.
  const p0Correlate: P0Correlate = {
    probeKey,
    probeKeyDegraded,
    rawInstrHash: instrHash,
    normInstrHash: instrNormHash,
    sentInstrHash,
    cchNormalized,
    toolsHash,
    model,
    effectiveEffort,
    legacyPromptCacheKey: convoKey,
    v2PromptCacheKeyCandidate: promptCacheKeyV2Candidate,
    usingPromptCacheKeyV2: usePromptCacheKeyV2,
    sentPromptCacheKey: promptCacheKey,
    firstUserRawHash: firstUserDiag.rawHash,
    firstUserRawLen: firstUserDiag.rawLen,
    firstUserStrippedHash: firstUserDiag.strippedHash,
    firstUserStrippedLen: firstUserDiag.strippedLen,
    textOnlyAssistantTurns,
    reasoningReuseSkipped,
    debugSeq: 0,
  };

  if (cacheDebug) {
    cacheDebugSeq += 1;
    const seq = cacheDebugSeq;
    p0Correlate.debugSeq = seq;
    const inflight = inFlightByKey.get(promptCacheKey) ?? new Set<number>();
    const inflightBefore = Array.from(inflight);
    inflight.add(seq);
    inFlightByKey.set(promptCacheKey, inflight);
    const prev = lastWireByKey.get(promptCacheKey);
    let divergeLine = "prev=none";
    if (prev) {
      let at = 0;
      const a = prev.json;
      const b = reqJson;
      while (at < a.length && at < b.length && a[at] === b[at]) at += 1;
      // Which input item does the divergence fall in? Count item boundaries in the common prefix.
      const inputStart = b.indexOf("\"input\":[");
      let itemIdx = -1;
      if (inputStart !== -1 && at > inputStart) {
        let acc = 0;
        const rel = at - (inputStart + "\"input\":[".length);
        for (let i = 0; i < input.length; i += 1) {
          acc += JSON.stringify(input[i]).length + (i ? 1 : 0);
          if (rel < acc) { itemIdx = i; break; }
        }
        if (itemIdx === -1) itemIdx = input.length;
      }
      divergeLine = `prev=#${prev.seq} divergeByte=${at} of prevBytes=${a.length} nowBytes=${b.length} inputStartByte=${inputStart} divergeItem=${itemIdx} prevAround=${JSON.stringify(a.slice(Math.max(0, at - 80), at + 100))} nowAround=${JSON.stringify(b.slice(Math.max(0, at - 80), at + 100))}`;
    }
    lastWireByKey.set(promptCacheKey, { seq, json: reqJson });
    console.log(
      `[codex] cache-debug req=#${seq} t=${Date.now()} key=${promptCacheKey.slice(0, 8)} inflightBefore=[${inflightBefore.join(",")}] sessionHeaders=${sessionHeaders} items=${input.length} bytes=${reqJson.length} ${divergeLine}`,
    );
    cacheDebugDump(`in-${cacheDebugRun}-${String(seq).padStart(3, "0")}.json`, JSON.stringify(body));
    cacheDebugDump(`req-${cacheDebugRun}-${String(seq).padStart(3, "0")}.json`, reqJson);
    cacheDebugDump(`hdr-${cacheDebugRun}-${String(seq).padStart(3, "0")}.json`, JSON.stringify({ ...headers, Authorization: "<redacted>" }));
  }

  // ── Responses-over-WebSocket ───────────────────────────────────────────────
  //
  // Tried first on the OAuth lane, because `previous_response_id` is accepted there and
  // refused on the HTTPS endpoint, which is what lets a turn send only its delta instead of
  // re-uploading the transcript. The full rationale and the measurements are in codex-ws.ts.
  //
  // This can only ever return a turn or null, so the HTTPS path below stays the fallback for
  // every failure mode -- and the fallback is free of side effects, because the attempt
  // resolves before anything is written to `res`. The API-key lane keeps using HTTPS: the
  // websocket endpoint measured here is the ChatGPT backend's, and nothing establishes that
  // api.openai.com negotiates the same transport with the same beta header.
  if (isOAuth) {
    const { input: _omitInput, ...shellBody } = reqBody;
    const wsTurn = await runCodexWsTurn({
      shellBody,
      input: inputForWs,
      headers,
    });
    if (wsTurn) {
      markLaneOk(lane);
      console.log(
        `[codex] ws turn ${wsTurn.incremental ? "INCREMENTAL" : "full"} items=${wsTurn.sentItems}/${inputForWs.length} sentKiB=${(wsTurn.sentBytes / 1024).toFixed(1)} (http would send ${(reqJson.length / 1024).toFixed(1)} KiB)`,
      );
      await pumpResponsesEvents(res, wsTurn.events, model, convoKey, lane, p0Correlate);
      return;
    }
  }

  const upstream = await fetchCodexWithRetry(url, {
    method: "POST",
    headers,
    body: reqJson,
  });

  if (!upstream.ok || !upstream.body) {
    const text = await upstream.text().catch(() => "<no-body>");
    const reason = classifyCodexUpstreamError(upstream.status, text);
    if (reason) markLaneDown(lane, reason, text);
    throw new Error(`OpenAI ${upstream.status}: ${text.slice(0, 500)}`);
  }

  // A 2xx response proves this lane is currently usable - accepted the request, not merely
  // "the socket connected". Flip back to ok here rather than waiting for the stream to
  // finish, since a request that later aborts mid-stream (see pumpResponsesStream's catch)
  // is a different failure than the lane being unavailable.
  markLaneOk(lane);
  if (cacheDiagCanary) {
    console.log(
      `[codex] p0.5-canary requestAccepted=true status=${upstream.status} - diagnostic field presence reported at stream completion`,
    );
  }
  await pumpResponsesStream(res, upstream.body, model, convoKey, lane, p0Correlate);
}

// ── SSE pump: Responses API events → Anthropic SSE events ────────────

// P0.5: the request-side half of the correlate record, carried through StreamState because
// cacheRead is only known at stream end (in finalize()).
type P0Correlate = {
  probeKey: string;
  probeKeyDegraded: boolean;
  rawInstrHash: string;
  normInstrHash: string;
  // Fix A attribution (work order section 6): sentInstrHash is the hash of what actually went
  // on the wire; cchNormalized is true only when the flag was on AND a replacement happened.
  sentInstrHash: string;
  cchNormalized: boolean;
  toolsHash: string;
  model: string;
  effectiveEffort: string;
  legacyPromptCacheKey: string;
  v2PromptCacheKeyCandidate: string;
  usingPromptCacheKeyV2: boolean;
  sentPromptCacheKey: string;
  firstUserRawHash: string;
  firstUserRawLen: number;
  firstUserStrippedHash: string;
  firstUserStrippedLen: number;
  textOnlyAssistantTurns: number;
  reasoningReuseSkipped: boolean;
  // CCX_CACHE_DEBUG: 0 when the flag is off.
  debugSeq: number;
};

type StreamState = {
  msgId: string;
  messageStarted: boolean;
  thinkingOpen: boolean;
  textOpen: boolean;
  blockIndex: number;
  funcCallByItemId: Map<string, { blockIndex: number; name: string; callId: string }>;
  // B2: the tool-call id tuple emitted by THIS response, retained separately from
  // funcCallByItemId -- that map has completed calls deleted from it during streaming
  // (response.output_item.done) and the remainder cleared in finalize(), so it cannot answer
  // "what ids did this whole response emit" by the time finalize() runs. Only ever appended
  // to, at response.output_item.added, using the exact id form sent downstream as the
  // Anthropic tool_use.id (so it is also what the client echoes back as call_id next turn).
  emittedToolCallIds: string[];
  newReasoningItems: ReasoningResponseItem[];
  textChars: number;
  thinkingChars: number;
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  stopReason: "end_turn" | "tool_use" | "max_tokens" | "stop_sequence" | "ccx_stream_aborted";
  // A0: wall-clock boundaries. startedAt = adapter state creation (just before the upstream
  // fetch); firstEventAt = first parsed upstream SSE event (TTFT as seen by the gateway).
  startedAt: number;
  firstEventAt: number;
  p0: P0Correlate;
};

/**
 * OpenAI reports cached input tokens as a subset of input_tokens, while the
 * Anthropic usage schema uses separate, additive input/cache-read buckets.
 * Split the overlapping OpenAI counts so Anthropic clients do not count the
 * cached portion twice when estimating context usage.
 */
export function splitInputTokenUsage(
  totalInputTokens: number,
  cachedInputTokens: number,
): { inputTokens: number; cacheReadInputTokens: number } {
  const total = Math.max(0, totalInputTokens);
  const cached = Math.min(total, Math.max(0, cachedInputTokens));
  return {
    inputTokens: total - cached,
    cacheReadInputTokens: cached,
  };
}

function makeState(p0: P0Correlate): StreamState {
  return {
    msgId: `msg_${Date.now()}`,
    messageStarted: false,
    thinkingOpen: false,
    textOpen: false,
    blockIndex: 0,
    funcCallByItemId: new Map(),
    emittedToolCallIds: [],
    newReasoningItems: [],
    textChars: 0,
    thinkingChars: 0,
    toolCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    stopReason: "end_turn",
    startedAt: Date.now(),
    firstEventAt: 0,
    p0,
  };
}

function ensureMessageStarted(res: FastifyReply, s: StreamState, model: string) {
  if (s.messageStarted) return;
  s.messageStarted = true;
  sendEvent(res, "message_start", {
    type: "message_start",
    message: {
      id: s.msgId,
      type: "message",
      role: "assistant",
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  });
}

function openThinking(res: FastifyReply, s: StreamState, model: string) {
  if (s.thinkingOpen) return;
  ensureMessageStarted(res, s, model);
  closeText(res, s);
  s.thinkingOpen = true;
  sendEvent(res, "content_block_start", {
    type: "content_block_start",
    index: s.blockIndex,
    content_block: { type: "thinking", thinking: "" },
  });
}

function closeThinking(res: FastifyReply, s: StreamState) {
  if (!s.thinkingOpen) return;
  sendEvent(res, "content_block_stop", { type: "content_block_stop", index: s.blockIndex });
  s.thinkingOpen = false;
  s.blockIndex += 1;
}

function openText(res: FastifyReply, s: StreamState, model: string) {
  if (s.textOpen) return;
  ensureMessageStarted(res, s, model);
  closeThinking(res, s);
  s.textOpen = true;
  sendEvent(res, "content_block_start", {
    type: "content_block_start",
    index: s.blockIndex,
    content_block: { type: "text", text: "" },
  });
}

function closeText(res: FastifyReply, s: StreamState) {
  if (!s.textOpen) return;
  sendEvent(res, "content_block_stop", { type: "content_block_stop", index: s.blockIndex });
  s.textOpen = false;
  s.blockIndex += 1;
}

function emitTextDelta(res: FastifyReply, s: StreamState, model: string, text: string) {
  if (!text) return;
  openText(res, s, model);
  s.textChars += text.length;
  sendEvent(res, "content_block_delta", {
    type: "content_block_delta",
    index: s.blockIndex,
    delta: { type: "text_delta", text },
  });
}

/**
 * Drive the downstream Anthropic SSE stream from already-parsed Responses events.
 *
 * The websocket transport delivers discrete JSON frames rather than an SSE byte stream, so it
 * joins the pipeline here. Everything downstream of `handleEvent` -- block bookkeeping, the
 * reasoning-cache write, the diagnostics in finalize() -- is identical on both transports, and
 * deliberately so: a metric that only exists on one transport cannot be used to compare them.
 */
async function pumpResponsesEvents(
  res: FastifyReply,
  events: AsyncIterable<Record<string, unknown>>,
  model: string,
  convoKey: string,
  lane: ProviderKey,
  p0: P0Correlate,
) {
  const s = makeState(p0);
  await consumeResponsesEvents(res, s, model, convoKey, lane, async (emit) => {
    for await (const ev of events) emit(ev);
  });
}

async function pumpResponsesStream(
  res: FastifyReply,
  body: ReadableStream<Uint8Array>,
  model: string,
  convoKey: string,
  lane: ProviderKey,
  p0: P0Correlate,
) {
  const s = makeState(p0);
  await consumeResponsesEvents(res, s, model, convoKey, lane, async (emit) => {
    const parser = createParser({
      onEvent: (ev: EventSourceMessage) => {
        if (!ev.data || ev.data === "[DONE]") return;
        let json: Record<string, unknown>;
        try {
          json = JSON.parse(ev.data);
        } catch {
          return;
        }
        emit(json);
      },
    });

    const reader = body.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      parser.feed(decoder.decode(value, { stream: true }));
    }
  });
}

/**
 * Shared body of both pumps: run `drive` to completion, handing each parsed event to
 * handleEvent, then finalize. A failure after the first downstream byte is reported in-band as
 * a truncated response rather than thrown, because the client is already reading a message it
 * cannot be told to discard.
 */
async function consumeResponsesEvents(
  res: FastifyReply,
  s: StreamState,
  model: string,
  convoKey: string,
  lane: ProviderKey,
  drive: (emit: (ev: Record<string, unknown>) => void) => Promise<void>,
) {
  try {
    await drive((ev) => handleEvent(res, s, model, ev, lane));
  } catch (err) {
    if (!s.messageStarted) throw err;
    console.error(
      `[codex] stream aborted mid-response: ${describeFetchError(err)} convoKey=${convoKey} textChars=${s.textChars} thinkingChars=${s.thinkingChars} toolCalls=${s.toolCalls}`,
    );
    if (!s.funcCallByItemId.size) {
      emitTextDelta(
        res,
        s,
        model,
        `[codex proxy error:CCX_STREAM_ABORTED] ${describeFetchError(err)}`,
      );
    }
    s.stopReason = "ccx_stream_aborted";
    finalize(res, s, model);
    return;
  }
  finalize(res, s, model);
}

function finalize(res: FastifyReply, s: StreamState, model: string) {
  ensureMessageStarted(res, s, model);
  closeThinking(res, s);
  closeText(res, s);
  for (const { blockIndex } of s.funcCallByItemId.values()) {
    sendEvent(res, "content_block_stop", { type: "content_block_stop", index: blockIndex });
  }
  s.funcCallByItemId.clear();

  // B2: key the write by the tool-call id tuple THIS response emitted (s.emittedToolCallIds),
  // never by convoKey -- that is what stopped every conversation from sharing one reasoning
  // slot and last-writer-winning each other's encrypted chain-of-thought. Called
  // unconditionally, including when newReasoningItems is empty: the old `if (length)` guard
  // is the stale-write bug (work order section 5) -- a turn that returns no reasoning must
  // clear the previous turn's blobs, not leave them in place for the next lookup to find.
  // When no stable id tuple was emitted (e.g. a text-only assistant turn) there is nothing to
  // key the write by, so nothing is written -- writing under a guessed key risks the exact
  // cross-conversation collision this fix exists to remove.
  const reasoningWriteKey = reasoningKeyForCallIds(s.emittedToolCallIds);
  if (reasoningWriteKey) {
    setReasoningItemsByKey(reasoningWriteKey, s.newReasoningItems);
  }

  console.log(
    `[codex] stream done ttftMs=${s.firstEventAt ? s.firstEventAt - s.startedAt : -1} totalMs=${Date.now() - s.startedAt} textChars=${s.textChars} thinkingChars=${s.thinkingChars} toolCalls=${s.toolCalls} input=${s.inputTokens} output=${s.outputTokens} cacheRead=${s.cacheReadInputTokens} stop=${s.stopReason}${s.p0.debugSeq ? ` req=#${s.p0.debugSeq}` : ""}`,
  );
  if (cacheDebug && s.p0.debugSeq) {
    const set = inFlightByKey.get(s.p0.sentPromptCacheKey);
    if (set) set.delete(s.p0.debugSeq);
    console.log(
      `[codex] cache-debug done req=#${s.p0.debugSeq} t=${Date.now()} cacheRead=${s.cacheReadInputTokens} input=${s.inputTokens} stillInflight=[${set ? Array.from(set).join(",") : ""}] emittedCallIds=${s.emittedToolCallIds.length} newReasoning=${s.newReasoningItems.length}`,
    );
  }
  // P0.5: one joined line correlating request-side state (computed in chatCodexOAuthInner,
  // carried here via s.p0) with cacheRead, which is only known now, at stream end.
  {
    const p = s.p0;
    console.log(
      `[codex] p0-correlate probeKey=${p.probeKey}${p.probeKeyDegraded ? " DEGRADED" : ""} rawInstrHash=${p.rawInstrHash} normInstrHash=${p.normInstrHash} sentInstrHash=${p.sentInstrHash} cchNormalized=${p.cchNormalized} toolsHash=${p.toolsHash} model=${p.model} effort=${p.effectiveEffort} legacyKey=${p.legacyPromptCacheKey.slice(0, 8)} v2Candidate=${p.v2PromptCacheKeyCandidate.slice(0, 8)} usingV2=${p.usingPromptCacheKeyV2} sentKey=${p.sentPromptCacheKey.slice(0, 8)} firstUserRawHash=${p.firstUserRawHash} firstUserRawLen=${p.firstUserRawLen} firstUserStrippedHash=${p.firstUserStrippedHash} firstUserStrippedLen=${p.firstUserStrippedLen} textOnlyAssistantTurns=${p.textOnlyAssistantTurns} reasoningReuseSkipped=${p.reasoningReuseSkipped} cacheRead=${s.cacheReadInputTokens}`,
    );
  }

  sendEvent(res, "message_delta", {
    type: "message_delta",
    delta: { stop_reason: s.stopReason, stop_sequence: null },
    usage: {
      input_tokens: s.inputTokens,
      output_tokens: s.outputTokens,
      cache_creation_input_tokens: s.cacheCreationInputTokens,
      cache_read_input_tokens: s.cacheReadInputTokens,
    },
  });
  sendEvent(res, "message_stop", { type: "message_stop" });
  if (!res.raw.writableEnded) res.raw.end();
}

function handleEvent(
  res: FastifyReply,
  s: StreamState,
  model: string,
  json: Record<string, unknown>,
  lane: ProviderKey,
) {
  if (!s.firstEventAt) s.firstEventAt = Date.now();
  const type = json.type as string | undefined;
  if (!type) return;

  switch (type) {
    case "response.created":
      return;

    case "response.output_text.delta": {
      const delta = json.delta as string | undefined;
      if (!delta) return;
      emitTextDelta(res, s, model, delta);
      return;
    }

    case "response.output_text.done": {
      // Some Responses streams only expose the full text in the done event.
      // Avoid duplicating normal delta streams by using this as a fallback.
      const text = json.text as string | undefined;
      if (text && s.textChars === 0) emitTextDelta(res, s, model, text);
      return;
    }

    case "response.content_part.done": {
      const part = json.part as { type?: string; text?: string } | undefined;
      const text = part?.type === "output_text" || part?.type === "text" ? part.text : "";
      if (text && s.textChars === 0) emitTextDelta(res, s, model, text);
      return;
    }

    case "response.reasoning_summary_text.delta":
    case "response.reasoning_text.delta": {
      const delta = json.delta as string | undefined;
      if (!delta) return;
      openThinking(res, s, model);
      s.thinkingChars += delta.length;
      sendEvent(res, "content_block_delta", {
        type: "content_block_delta",
        index: s.blockIndex,
        delta: { type: "thinking_delta", thinking: delta },
      });
      return;
    }

    case "response.reasoning_summary_part.added":
      // Soft paragraph break between summary parts to keep them readable inside one thinking block.
      if (s.thinkingOpen) {
        sendEvent(res, "content_block_delta", {
          type: "content_block_delta",
          index: s.blockIndex,
          delta: { type: "thinking_delta", thinking: "\n\n" },
        });
      }
      return;

    case "response.output_item.added": {
      const item = json.item as
        | { type?: string; id?: string; call_id?: string; name?: string }
        | undefined;
      if (!item) return;
      if (item.type === "function_call") {
        ensureMessageStarted(res, s, model);
        closeText(res, s);
        closeThinking(res, s);
        const callId = item.call_id || item.id || `call_${Date.now()}`;
        const name = item.name || "";
        s.funcCallByItemId.set(item.id || callId, {
          blockIndex: s.blockIndex,
          name,
          callId,
        });
        s.toolCalls += 1;
        // B2: append (never replace) the exact id form sent below as tool_use.id -- that is
        // what the client echoes back as tool_use.id next turn, which toResponsesInput turns
        // back into `call_id` (case "tool_use") and `function_call_output.call_id` (case
        // "tool_result"). funcCallByItemId cannot serve this: completed calls are deleted from
        // it below (response.output_item.done) and the rest is cleared in finalize().
        s.emittedToolCallIds.push(callId);
        sendEvent(res, "content_block_start", {
          type: "content_block_start",
          index: s.blockIndex,
          content_block: { type: "tool_use", id: callId, name, input: {} },
        });
        s.blockIndex += 1;
        s.stopReason = "tool_use";
      } else if (item.type === "web_search_call") {
        console.log(`[codex] web_search invoked`);
      }
      return;
    }

    case "response.function_call_arguments.delta": {
      const itemId = (json.item_id || json.id) as string | undefined;
      const delta = json.delta as string | undefined;
      if (!itemId || !delta) return;
      const entry = s.funcCallByItemId.get(itemId);
      if (!entry) return;
      sendEvent(res, "content_block_delta", {
        type: "content_block_delta",
        index: entry.blockIndex,
        delta: { type: "input_json_delta", partial_json: delta },
      });
      return;
    }

    case "response.function_call_arguments.done":
      // Full arguments string is already streamed via deltas. output_item.done closes the block.
      return;

    case "response.output_item.done": {
      const item = json.item as
        | {
            type?: string;
            id?: string;
            call_id?: string;
            name?: string;
            arguments?: string;
            content?: Array<{ type?: string; text?: string }>;
            summary?: Array<{ type: string; text: string }>;
            encrypted_content?: string | null;
          }
        | undefined;
      if (!item) return;

      if (item.type === "function_call") {
        const itemId = item.id || item.call_id || "";
        const entry = s.funcCallByItemId.get(itemId);
        if (entry) {
          sendEvent(res, "content_block_stop", {
            type: "content_block_stop",
            index: entry.blockIndex,
          });
          s.funcCallByItemId.delete(itemId);
        }
      } else if (item.type === "reasoning") {
        s.newReasoningItems.push({
          type: "reasoning",
          summary: (item.summary ?? []).map((p) => ({
            type: "summary_text",
            text: p.text,
          })),
          encrypted_content: item.encrypted_content ?? null,
        });
      } else if (item.type === "message" && s.textChars === 0) {
        emitTextDelta(res, s, model, textFromResponsesMessageItem(item));
      }
      return;
    }

    case "response.completed": {
      const resp = json.response as
        | {
            usage?: {
              input_tokens?: number;
              output_tokens?: number;
              input_tokens_details?: { cached_tokens?: number };
            };
            end_turn?: boolean;
          }
        | undefined;
      const u = resp?.usage;
      if (u) {
        const inputUsage = splitInputTokenUsage(
          u.input_tokens ?? 0,
          u.input_tokens_details?.cached_tokens ?? 0,
        );
        s.inputTokens = inputUsage.inputTokens;
        s.outputTokens = u.output_tokens ?? 0;
        s.cacheReadInputTokens = inputUsage.cacheReadInputTokens;
      }
      // P0.5 backend canary: log whether the unverified prompt_cache_diagnostics field (see
      // the CCX_CACHE_DIAG_CANARY doc comment in chatCodexOAuthInner) actually came back.
      // Reads the env directly rather than threading a flag through StreamState, matching how
      // reasoningSummary()/textVerbosity() read their own env vars elsewhere in this file.
      if (process.env.CCX_CACHE_DIAG_CANARY === "1") {
        const diag = (resp as { prompt_cache_diagnostics?: unknown } | undefined)?.prompt_cache_diagnostics;
        console.log(
          `[codex] p0.5-canary diagnosticField=${diag !== undefined ? "present" : "ABSENT"} value=${diag !== undefined ? JSON.stringify(diag) : "none"}`,
        );
      }
      return;
    }

    case "response.failed":
    case "response.incomplete": {
      const resp = json.response as
        | { error?: { message?: string }; incomplete_details?: { reason?: string } }
        | undefined;
      const msg =
        resp?.error?.message ||
        resp?.incomplete_details?.reason ||
        `Codex returned ${type}`;
      const reason = classifyCodexStreamFailure(msg);
      if (reason) markLaneDown(lane, reason, msg);
      throw new Error(msg);
    }

    default:
      return;
  }
}
