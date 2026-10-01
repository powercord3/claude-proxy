// Per-session cache of Codex Responses-API encrypted reasoning blobs.
//
// Codex returns Reasoning items with an opaque `encrypted_content` field. When you echo
// the same blob back on the next turn, the server unpacks it and gets the model's prior
// chain-of-thought "for free" — no extra latency, better quality on multi-step tasks.
//
// Claude Code is unaware of these blobs. The cache used to be keyed by a hash of the first
// user turn's text, on the theory that the same Claude conversation would map to the same
// slot across turns. That theory was wrong: Claude Code prepends a large, identical
// `<system-reminder>` (the global CLAUDE.md) to the first user message on every conversation
// on a host, so the truncated hash collided across *distinct* conversations — and, separately,
// a fan-out of N identically-prompted agents collides on the full text too, hash or no hash.
// Reasoning is now keyed to the tool-call ID tuple emitted by the response that produced it
// (`reasoningKeyForCallIds`): call ids are unique per request and per agent, so they don't
// collide the way prompt text does. `prompt_cache_key` (affinity, not correctness) is derived
// separately — see `promptCacheKeyFor` and `conversationKey` below. Cache entries expire after
// a configurable period of inactivity (four hours by default), with bounded live and
// historical observability maps.

import { createHash } from "crypto";
import type { AnthropicMessage } from "./types.js";

type ReasoningItem = {
  type: "reasoning";
  summary: Array<{ type: "summary_text"; text: string }>;
  encrypted_content?: string | null;
};

type Entry = {
  items: ReasoningItem[];
  lastAccess: number;
};

type SeenEntry = {
  lastActivity: number;
  itemCount: number;
  lapseLogged: boolean;
};

const DEFAULT_TTL_MS = 4 * 60 * 60 * 1000;
const OLD_TTL_MS = 30 * 60 * 1000;
const configuredTtlMs = Number(process.env.CCX_REASONING_TTL_MS);
const TTL_MS = Number.isFinite(configuredTtlMs) && configuredTtlMs > 0
  ? configuredTtlMs
  : DEFAULT_TTL_MS;
const DEFAULT_LIVE_CACHE_LIMIT = 256;
const configuredCacheMax = Number(process.env.CCX_REASONING_CACHE_MAX);
const LIVE_CACHE_LIMIT = Number.isFinite(configuredCacheMax) && configuredCacheMax > 0
  ? configuredCacheMax
  : DEFAULT_LIVE_CACHE_LIMIT;
const SEEN_LIMIT = 512;
const cache = new Map<string, Entry>();
const seen = new Map<string, SeenEntry>();

function userTextOf(m: AnthropicMessage): string {
  if (m.role !== "user") return "";
  if (typeof m.content === "string") return m.content;
  return m.content
    .map((b) => {
      if (b.type === "text") return b.text;
      if (b.type === "tool_result") {
        return typeof b.content === "string" ? b.content : JSON.stringify(b.content);
      }
      return "";
    })
    .join("\n");
}

function evictOldest<T extends { lastAccess?: number; lastActivity?: number }>(
  entries: Map<string, T>,
  limit: number,
) {
  while (entries.size > limit) {
    let oldestKey: string | undefined;
    let oldestTime = Infinity;
    for (const [key, value] of entries) {
      const time = value.lastAccess ?? value.lastActivity ?? Infinity;
      if (time < oldestTime) {
        oldestKey = key;
        oldestTime = time;
      }
    }
    if (oldestKey === undefined) break;
    entries.delete(oldestKey);
  }
}

const REMINDER_OPEN = "<system-reminder>";
const REMINDER_CLOSE = "</system-reminder>";

/**
 * Strips zero or more well-formed leading `<system-reminder>...</system-reminder>` blocks
 * (tolerating whitespace before and between them), returning the remainder with leading
 * whitespace trimmed. Stops at the first thing that isn't a closed reminder block, and on an
 * unclosed/malformed opening tag stops there rather than guessing where the block would have
 * ended — under-stripping is safe (it just leaves a stable prefix in the hash basis),
 * over-stripping would eat real conversation text. Never throws; the loop strictly shortens
 * `rest` each iteration it doesn't break, so it can't spin.
 */
export function stripLeadingSystemReminders(text: string): string {
  let rest = text;
  for (;;) {
    const afterWs = rest.replace(/^\s+/, "");
    if (!afterWs.startsWith(REMINDER_OPEN)) {
      rest = afterWs;
      break;
    }
    const closeAt = afterWs.indexOf(REMINDER_CLOSE, REMINDER_OPEN.length);
    if (closeAt === -1) {
      rest = afterWs;
      break;
    }
    rest = afterWs.slice(closeAt + REMINDER_CLOSE.length);
  }
  return rest.replace(/^\s+/, "");
}

/**
 * Legacy conversation key: hash of the first user turn's raw text, truncated to 4096 chars
 * before hashing. Kept unchanged as the default `prompt_cache_key` source while
 * `CCX_PROMPT_CACHE_KEY_V2` is off — the truncation is exactly the bug B1 fixes (it never
 * reaches past the ~20KB CLAUDE.md reminder prefix), so this is deliberately not repaired
 * in place; see `promptCacheKeyFor`.
 */
export function conversationKey(messages: AnthropicMessage[]): string {
  const firstUserIdx = messages.findIndex((m) => m.role === "user");
  if (firstUserIdx === -1) return "anon";
  const first = userTextOf(messages[firstUserIdx]).slice(0, 4096);
  return createHash("sha256").update(first).digest("hex").slice(0, 24);
}

/**
 * B1 replacement for `conversationKey`: hashes the first user message with any leading
 * `<system-reminder>` blocks stripped, and with NO length truncation — the untruncated
 * remainder is the point, since the truncation is what let every conversation on a host
 * collide behind a shared reminder prefix. This key is for `prompt_cache_key` affinity only,
 * not for reasoning isolation (see `reasoningKeyForCallIds`): identical fan-out prompts
 * sharing this key is acceptable, arguably correct.
 */
export function promptCacheKeyFor(messages: AnthropicMessage[]): string {
  const firstUserIdx = messages.findIndex((m) => m.role === "user");
  if (firstUserIdx === -1) return "anon";
  const raw = userTextOf(messages[firstUserIdx]);
  const stripped = stripLeadingSystemReminders(raw);
  // A first user message that is entirely reminder blocks strips to nothing; falling back
  // to the raw text means those conversations are indistinguishable from each other and
  // will legitimately collide on this key. That's the same affinity-only tradeoff as the
  // fan-out case above, not a new one.
  const basis = stripped.length > 0 ? stripped : raw;
  return createHash("sha256").update(basis).digest("hex").slice(0, 24);
}

/**
 * P0.4 support: hashes and lengths only, never content, for the raw vs. reminder-stripped
 * first user message. This is what the Phase 0 trace uses to confirm the stripped hash is
 * stable across turns before B1 is allowed to key on it.
 */
export function firstUserHashDiagnostics(messages: AnthropicMessage[]): {
  rawHash: string;
  rawLen: number;
  strippedHash: string;
  strippedLen: number;
} {
  const firstUserIdx = messages.findIndex((m) => m.role === "user");
  const raw = firstUserIdx === -1 ? "" : userTextOf(messages[firstUserIdx]);
  const stripped = stripLeadingSystemReminders(raw);
  return {
    rawHash: createHash("sha256").update(raw).digest("hex").slice(0, 12),
    rawLen: raw.length,
    strippedHash: createHash("sha256").update(stripped).digest("hex").slice(0, 12),
    strippedLen: stripped.length,
  };
}

/**
 * Returns the conversation's `prompt_cache_key` formatted as a UUID from a 24-hex-char key.
 * Pure: no cache reads, writes, or eviction. It used to lazily create a reasoning-cache entry
 * as a side effect (and could evict others doing so) — that coupled `prompt_cache_key`
 * derivation to reasoning-cache lifetime for no reason. The two are independent now: reasoning
 * entries are created by `setReasoningItemsByKey` against a call-id key, not this one.
 */
export function threadIdFor(key: string): string {
  return `${key.slice(0, 8)}-${key.slice(8, 12)}-${key.slice(12, 16)}-${key.slice(16, 20)}-${key.slice(20, 24).padEnd(12, "0")}`;
}

/**
 * B2: derives the reasoning-cache key from the tool-call id tuple that produced the
 * reasoning, not from any prompt hash — prompt hashes collide across identically-prompted
 * fan-out agents, tool-call ids don't. Falsy entries are dropped and the rest de-duplicated
 * and sorted before joining, so the key is invariant to which call happens to complete first
 * in a stream. Returns null when there is nothing stable to key on (empty array, or every
 * entry falsy); the caller MUST treat null as "skip reasoning reuse for this transition" —
 * hashing the empty string here would silently turn "no stable id" into a fake shared key.
 */
export function reasoningKeyForCallIds(callIds: string[]): string | null {
  const ids = Array.from(new Set(callIds.filter((id): id is string => Boolean(id)))).sort();
  if (ids.length === 0) return null;
  return createHash("sha256").update(ids.join("\n")).digest("hex").slice(0, 24);
}

/** All cached reasoning items for this call-id key, in arrival order. */
export function reasoningItemsByKey(key: string): ReasoningItem[] {
  reap();
  const now = Date.now();
  const e = cache.get(key);
  if (!e) {
    const prior = seen.get(key);
    if (prior && prior.itemCount > 0 && !prior.lapseLogged) {
      const idleMin = Math.floor((now - prior.lastActivity) / 60_000);
      if (now - prior.lastActivity >= TTL_MS) {
        console.log(`[codex] reasoning-cache LAPSED: key=${key.slice(0,8)} idle=${idleMin}m items=${prior.itemCount} - continuing with full text history and no reasoning state`);
      } else {
        console.log(`[codex] reasoning-cache EVICTED: key=${key.slice(0,8)} idle=${idleMin}m items=${prior.itemCount} - dropped by the ${LIVE_CACHE_LIMIT}-entry cache cap, not by the TTL; raise CCX_REASONING_CACHE_MAX if this recurs`);
      }
      prior.lapseLogged = true;
    }
    return [];
  }
  const idleMs = now - e.lastAccess;
  if (idleMs > OLD_TTL_MS) {
    const idleMin = Math.floor(idleMs / 60_000);
    console.log(`[codex] reasoning-cache RESCUED: key=${key.slice(0,8)} idle=${idleMin}m - would have lapsed under the old 30m TTL`);
  }
  e.lastAccess = now;
  return e.items;
}

/**
 * Replace the cached reasoning items for this call-id key with what the server just sent.
 * Always records, including an empty `items` array: the previous behaviour of only writing
 * `if (items.length)` left a prior turn's blobs in place on a turn that returned no reasoning,
 * which is a stale-write bug, not a cache-friendly no-op. An explicit empty write (or an
 * eviction) is required so a text-only turn can't resurrect stale chain-of-thought later.
 */
export function setReasoningItemsByKey(key: string, items: ReasoningItem[]): void {
  reap();
  const now = Date.now();
  const e = cache.get(key) ?? { items: [], lastAccess: now };
  e.items = items;
  e.lastAccess = now;
  cache.set(key, e);
  evictOldest(cache, LIVE_CACHE_LIMIT);

  seen.set(key, {
    lastActivity: now,
    itemCount: items.length,
    lapseLogged: false,
  });
  evictOldest(seen, SEEN_LIMIT);
}

function reap() {
  const cutoff = Date.now() - TTL_MS;
  for (const [k, v] of cache) if (v.lastAccess < cutoff) cache.delete(k);
}
