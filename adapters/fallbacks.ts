// Per-alias fallback chains, read from ~/.claude-proxy/fallbacks.json (written by
// model-slot.py). Format:
//
//   { "version": 1,
//     "slots": { "agent-review": ["anthropic:claude-opus-5-5@medium",
//                                 "openrouter:moonshotai/kimi-k3@high"] } }
//
// Each entry is a full target in the same grammar as a shortcuts.json value
// (provider:model[@effort][!fast]) and is resolved through parseProviderModel, so the two
// files can never disagree about what a string means. The alias itself is still resolved
// through shortcuts.json as its primary; the chain lists what to try AFTER it.
//
// Re-read on mtime like shortcuts.json (map.ts), so model-slot.py can edit a chain while the
// proxy runs. Missing file = no fallbacks. Corrupt file = no fallbacks, logged once per
// distinct mtime rather than on every request.
//
// This module also owns the one decision the gateway needs: "did this attempt fail because
// its LANE is unavailable?" It does not classify errors itself - the adapters' classifiers
// already decide that and record it via markLaneDown - it reads their verdict back, plus the
// incident log's transport-refusal class for a connection that never opened.
import { readFileSync, statSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import type { ProviderKey } from "./types.js";
import { laneDownSignalCount, laneHealth } from "./provider-health.js";
import { classifyIncident } from "./incident-log.js";

const FALLBACKS_PATH = join(homedir(), ".claude-proxy", "fallbacks.json");

let cache: Record<string, string[]> = {};
let cacheMtime = 0;
let warnedMtime = 0;

function loadFallbacks(): Record<string, string[]> {
  let mtime: number;
  try {
    mtime = statSync(FALLBACKS_PATH).mtimeMs;
  } catch {
    // Missing: no fallbacks. Reset so deleting the file genuinely disables them.
    cache = {};
    cacheMtime = 0;
    return cache;
  }
  if (mtime === cacheMtime) return cache;
  try {
    const parsed = JSON.parse(readFileSync(FALLBACKS_PATH, "utf8"));
    if (!parsed || typeof parsed !== "object" || parsed.version !== 1 ||
        !parsed.slots || typeof parsed.slots !== "object" || Array.isArray(parsed.slots)) {
      throw new Error(`expected {"version":1,"slots":{...}}`);
    }
    const next: Record<string, string[]> = {};
    for (const [alias, chain] of Object.entries(parsed.slots)) {
      if (!Array.isArray(chain)) continue;
      const targets = chain.filter((t): t is string => typeof t === "string" && t.length > 0);
      if (targets.length) next[alias.toLowerCase()] = targets;
    }
    cache = next;
    cacheMtime = mtime;
    console.log(`[fallback] Loaded ${Object.keys(next).length} fallback chain(s) from ${FALLBACKS_PATH}`);
  } catch (e: any) {
    cache = {};
    cacheMtime = mtime;
    if (warnedMtime !== mtime) {
      warnedMtime = mtime;
      console.error(`[fallback] ignoring ${FALLBACKS_PATH}: ${e?.message || e}`);
    }
  }
  return cache;
}

/** The fallback targets for `alias` (not including its primary), or [] when none. */
export function fallbackChain(alias: string): string[] {
  if (!alias) return [];
  const chains = loadFallbacks();
  const exact = alias.toLowerCase();
  if (chains[exact]) return chains[exact];
  // The same slot also arrives decorated: model-slot.py writes `[1m]` companion shortcuts
  // (e.g. `sonnet-ab[1m]`), and a caller may add an explicit @effort or !tier. None of those
  // change which slot it is, so strip them and look again.
  const base = exact
    .replace(/\[[^\]]*\]$/, "")
    .replace(/![a-z]+$/, "")
    .replace(/@[a-z]+$/, "")
    .replace(/\[[^\]]*\]$/, "");
  return chains[base] ?? [];
}

// Anthropic-compatible passthrough (anthropic, glm) has no markLaneDown classifier: its lane
// is authenticated with the CLIENT's own token, so the proxy can neither probe it nor honestly
// say it is down for everyone. The thrown error is "Upstream error (<status>): <body>" with
// statusCode set (anthropic-pass.ts). These are the unavailability shapes Anthropic documents:
// 429 rate_limit_error (the subscription/usage limit surfaces this way), 402 / "credit balance
// is too low" (API-key billing), and authentication/permission errors.
function passthroughLaneUnavailable(status: number | undefined, message: string): boolean {
  if (status === 429 || status === 402) return true;
  if (status === 401 || status === 403) {
    return /authentication_error|permission_error|invalid.?x-api-key|oauth/i.test(message);
  }
  if (status === 400 && /credit balance is too low/i.test(message)) return true;
  return false;
}

/**
 * Is `err`, thrown by an attempt on `lane`, a lane-unavailability failure worth falling back
 * from? Returns the reason tag for the `[fallback]` log line, or null to surface the error.
 */
export function laneUnavailableReason(
  lane: ProviderKey,
  err: any,
  downSignalsBefore: number,
): string | null {
  const message = String(err?.message ?? err ?? "");
  // Connection never opened (refused, reset, DNS, bare "fetch failed") - the incident log's
  // own classifier, so the two can't disagree about what "unreachable" means.
  if (classifyIncident(message, err?.cause) === "transport-refusal") return "transport-refusal";
  if (lane === "anthropic" || lane === "glm") {
    return passthroughLaneUnavailable(err?.statusCode, message)
      ? `upstream-${err?.statusCode}`
      : null;
  }
  // Every other adapter classifies its own errors and records the definitive ones via
  // markLaneDown before throwing - read back rather than re-derived. Only a markLaneDown made
  // DURING this attempt counts: a stale record (resets_at passed, primary retried) must not
  // turn an unrelated error such as a 400 into a hop that hides it.
  if (laneDownSignalCount(lane) === downSignalsBefore) return null;
  const rec = laneHealth(lane);
  return rec?.status === "down" ? rec.reason || "lane-down" : null;
}
