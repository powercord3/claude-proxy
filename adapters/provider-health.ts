// Per-lane provider health, written to disk so a hook can read it every turn and steer
// affected aliases off a dead lane without waiting for a spawn to fail first.
//
// Two failure modes look identical from inside a request handler - a lane that will work
// again in ten seconds (a timeout, a dropped connection, a transient 5xx) and a lane that is
// definitively out until something changes (a 5-hour usage limit, an empty balance, a refresh
// token the server has revoked). Only the second kind belongs here. Marking a lane down on a
// single timeout would make the file lie on every network blip, which is worse than not
// having it - see each adapter's own classifier for where that line is drawn, and keep
// per-provider match logic there, beside the code that knows that provider's error shape.
// This module only owns the state machine and the file.
//
// Schema written to ~/.claude-proxy/provider-health.json (the same directory shortcuts.json
// and the OAuth token caches already live in) - one JSON object, atomically replaced:
//
//   {
//     "<ProviderKey>": {
//       "status": "down" | "ok",
//       "reason": string,             // classifier tag, e.g. "codex-quota", "balance-402",
//                                      // "auth-expired"; "" once a lane has never gone down
//       "detected_at": string,        // ISO 8601 timestamp of the last status transition
//       "last_error_snippet": string, // truncated raw error text behind the last "down";
//                                      // "" while ok
//       "resets_at"?: string          // ISO 8601 time the provider itself said the outage
//                                      // ends (codex's usage_limit_reached body carries it
//                                      // as unix seconds). Present only on a "down" record
//                                      // whose error named one; absent means "unknown", not
//                                      // "never". A past value does NOT mean the lane is ok -
//                                      // only a successful request or recovery probe
//                                      // (lane-probe.ts) flips it back - but readers may
//                                      // treat it as "probably recovered, unconfirmed".
//     },
//     ...
//   }
//
// A lane that has never been marked down or up through this module simply has no key here -
// absence is "never observed", not "known ok". The session-facing half that reads this file
// and steers aliases (provider-health-surface) is a separate task and owns that distinction.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { join } from "path";
import { AsyncLocalStorage } from "async_hooks";
import { homedir } from "os";
import type { ProviderKey } from "./types.js";
import { recordRecovery } from "./incident-log.js";

const STATE_DIR = join(homedir(), ".claude-proxy");
const HEALTH_PATH = join(STATE_DIR, "provider-health.json");

export type LaneStatus = "down" | "ok";

export interface LaneHealth {
  status: LaneStatus;
  reason: string;
  detected_at: string;
  last_error_snippet: string;
  resets_at?: string;
}

export type ProviderHealthState = Partial<Record<ProviderKey, LaneHealth>>;

// Long enough to be useful in a log line, short enough that a stack trace or an HTML error
// page doesn't blow out the file.
const MAX_SNIPPET = 300;

function loadInitial(): ProviderHealthState {
  try {
    const parsed = JSON.parse(readFileSync(HEALTH_PATH, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as ProviderHealthState;
    }
  } catch {
    // Missing, unreadable, or malformed: start from empty state rather than throwing at
    // module load - a corrupt health file must not be able to take the whole proxy down.
  }
  return {};
}

const state: ProviderHealthState = loadInitial();

function persist(): void {
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    // Temp file + rename: a hook may read this file on every turn, and a reader landing
    // mid-write would otherwise see a truncated or torn JSON body. Suffixed with pid+time so
    // two overlapping writes in the same process (rare, since these are all sync calls) never
    // collide on the same temp name.
    const tmpPath = `${HEALTH_PATH}.tmp-${process.pid}-${Date.now()}`;
    writeFileSync(tmpPath, JSON.stringify(state, null, 2), "utf8");
    renameSync(tmpPath, HEALTH_PATH);
  } catch (e: any) {
    // Health tracking must never be the reason a request fails.
    console.error(`[health] failed to persist ${HEALTH_PATH}: ${e?.message || e}`);
  }
}

function snippet(text: string): string {
  const compact = String(text ?? "").replace(/\s+/g, " ").trim();
  // MAX_SNIPPET is the stored result's total length, so the "..." suffix has to come out of
  // the budget rather than on top of it.
  return compact.length > MAX_SNIPPET
    ? `${compact.slice(0, MAX_SNIPPET - 3)}...`
    : compact;
}

/**
 * Record a hard, definitive provider-unavailable signal for `lane`: a quota/usage-limit
 * response, an empty-balance/402, or an auth failure a refresh could not fix. Callers decide
 * what counts as "definitive" - this function trusts whatever reason it is handed and never
 * itself inspects a status code or error body.
 *
 * A no-op when the lane is already down for the same reason, so a burst of identical failures
 * writes the file and logs a `[health]` line once, not once per request. A *different* reason
 * while already down still counts as a transition and is written - e.g. codex flipping from
 * `auth-expired` to `codex-quota` is new information even though `status` does not change.
 */
// Every markLaneDown call, including the no-op repeats. A stale down record says nothing
// about the attempt in hand; a count that moved during the attempt says its own error was
// classified as definitive (fallbacks.ts compares before/after).
const downSignals = new Map<ProviderKey, number>();

/** How many times markLaneDown has been called for `lane` in this process. */
export function laneDownSignalCount(lane: ProviderKey): number {
  return downSignals.get(lane) ?? 0;
}

export function markLaneDown(
  lane: ProviderKey,
  reason: string,
  errorText: string,
  resetsAt?: Date,
): void {
  downSignals.set(lane, (downSignals.get(lane) ?? 0) + 1);
  const prev = state[lane];
  const resets_at =
    resetsAt && !Number.isNaN(resetsAt.getTime()) ? resetsAt.toISOString() : undefined;
  if (prev?.status === "down" && prev.reason === reason) {
    // Same outage, but the provider may have moved its reset time (a fresh usage-limit reply
    // after the old window passed). Keep the stored time current without logging a
    // transition - a stale resets_at is exactly what made the banner lie before.
    if (resets_at && resets_at !== prev.resets_at) {
      state[lane] = { ...prev, resets_at };
      persist();
      console.log(`[health] ${lane}: still down (${reason}), resets_at -> ${resets_at}`);
    }
    return;
  }

  const from = prev?.status ?? "unknown";
  state[lane] = {
    status: "down",
    reason,
    detected_at: new Date().toISOString(),
    last_error_snippet: snippet(errorText),
    ...(resets_at ? { resets_at } : {}),
  };
  persist();
  console.log(
    `[health] ${lane}: ${from} -> down (${reason})${resets_at ? ` resets_at=${resets_at}` : ""} ${state[lane]!.last_error_snippet}`,
  );
}

// Why a lane recovered, when the caller is not the adapter itself. The recovery probe
// (lane-probe.ts) runs a request through each adapter's NORMAL call path, and it is the
// adapter - not the probe - that calls markLaneOk on its 2xx. AsyncLocalStorage carries the
// probe's tag down that path without threading a parameter through every adapter, and
// without mislabelling a real request that happens to succeed concurrently.
const okReasonContext = new AsyncLocalStorage<string>();

/** Run `fn` so that any markLaneOk it triggers is logged with `reason` (e.g. "probed-200"). */
export function withRecoveryReason<T>(reason: string, fn: () => Promise<T>): Promise<T> {
  return okReasonContext.run(reason, fn);
}

/**
 * Record a successful response from `lane`. A no-op unless the lane was previously marked
 * down, so recovery is as visible as failure without writing the file on every healthy
 * request - the common case, by far.
 */
export function markLaneOk(lane: ProviderKey, via?: string): void {
  const prev = state[lane];
  if (!prev || prev.status === "ok") return; // no transition

  const how = via ?? okReasonContext.getStore();
  state[lane] = {
    status: "ok",
    reason: "",
    detected_at: new Date().toISOString(),
    last_error_snippet: "",
  };
  persist();
  console.log(
    `[health] ${lane}: down -> ok (${how ? `${how}, ` : ""}recovered from ${prev.reason})`,
  );
  // Recovery here is the one place a lane's down status would otherwise just disappear once
  // things start working again - attach it to any open incident (see incident-log.ts) so a
  // multi-lane outage that recovers before anyone looks still has a record afterward.
  recordRecovery(lane, how);
}

/** Every lane currently recorded as down, with its record. */
export function downLanes(): Array<[ProviderKey, LaneHealth]> {
  return (Object.entries(state) as Array<[ProviderKey, LaneHealth | undefined]>)
    .filter((e): e is [ProviderKey, LaneHealth] => e[1]?.status === "down");
}

/**
 * Should routing treat `lane` as unavailable right now? Down with no known reset time, or a
 * reset time still in the future. A down record whose resets_at has passed is "probably
 * recovered, unconfirmed" - worth one real attempt rather than skipping forever.
 */
export function laneBelievedDown(lane: ProviderKey, now = Date.now()): boolean {
  const rec = state[lane];
  if (rec?.status !== "down") return false;
  if (!rec.resets_at) return true;
  const t = Date.parse(rec.resets_at);
  return Number.isNaN(t) || t > now;
}

/** Current known health for `lane`, or undefined if it has never transitioned either way. */
export function laneHealth(lane: ProviderKey): LaneHealth | undefined {
  return state[lane];
}
