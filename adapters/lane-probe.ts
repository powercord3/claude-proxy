// Recovery probe for lanes marked down in provider-health.json.
//
// A lane only returns to "ok" when a real request through it succeeds. But the session banner
// (spawn-level.py) tells every session to move off a down lane, so once one goes down nothing
// is sent to it and it can stay "down" long after the outage ended - measured on codex-oauth,
// whose usage_limit_reached body even says when the quota resets. This module closes that
// loop: while any lane is down, it sends one minimal request through that lane's NORMAL
// adapter path (so the adapter's own classifiers and markLaneOk/markLaneDown decide the
// outcome, exactly as for a real request) and tags any recovery it causes "probed-200".
//
// Schedule per down lane:
//   resets_at known   first probe at resets_at + 60s, then every PROBE_INTERVAL
//   no resets_at      every PROBE_INTERVAL, counted from proxy start or the last probe
//   deepseek          never more often than hourly - balance-402 only recovers by top-up
//
// Lanes with no probe below (anthropic, glm, gemini*) are never marked down by any adapter
// today; the anthropic lane in particular authenticates with the client's own token, which
// the proxy does not hold between requests.
//
// Env: CCX_LANE_PROBE=0 disables it; CCX_LANE_PROBE_TICK_MS sets the check cadence (default
// 60000 - probes land at most one tick after they fall due).
import type { FastifyReply } from "fastify";
import type { AnthropicRequest, ProviderKey } from "./types.js";
import { PROVIDER_FAST_MODEL } from "./map.js";
import { downLanes, laneHealth, withRecoveryReason, type LaneHealth } from "./provider-health.js";
import { chatCodexOAuth } from "./providers/codex-oauth.js";
import { chatOpenRouter } from "./providers/openrouter.js";
import { chatDeepSeek } from "./providers/deepseek.js";
import { chatClinePass } from "./providers/cline-pass.js";

const MINUTE = 60_000;
export const PROBE_INTERVAL_MS = 15 * MINUTE;
export const DEEPSEEK_MIN_INTERVAL_MS = 60 * MINUTE;
const AFTER_RESET_MS = MINUTE;
// A probe that never settles must not pin its lane as "in flight" forever.
const PROBE_TIMEOUT_MS = 2 * MINUTE;

type ProbeFn = (res: FastifyReply, body: AnthropicRequest) => Promise<unknown>;

const fast = (lane: ProviderKey) => PROVIDER_FAST_MODEL[lane] ?? "";

const PROBES: Partial<Record<ProviderKey, ProbeFn>> = {
  "codex-oauth": (res, body) => chatCodexOAuth(res, body, fast("codex-oauth"), undefined, "low"),
  openai: (res, body) => {
    const key = process.env.OPENAI_API_KEY;
    if (!key) throw new Error("OPENAI_API_KEY not set");
    return chatCodexOAuth(res, body, fast("openai"), key, "low");
  },
  openrouter: (res, body) => chatOpenRouter(res, body, fast("openrouter"), process.env.OPENROUTER_API_KEY),
  deepseek: (res, body) => chatDeepSeek(res, body, fast("deepseek"), process.env.DEEPSEEK_API_KEY, "none"),
  "cline-pass": (res, body) => chatClinePass(res, body, fast("cline-pass"), "none"),
};

/**
 * When `lane` (down, per `rec`) should next be probed, in epoch ms. Pure: the scheduling
 * contract is the part a wrong answer makes expensive (probing a quota-exhausted lane every
 * tick) or useless (never probing it), so it is kept testable without timers or a network.
 */
export function nextProbeAt(
  lane: ProviderKey,
  rec: LaneHealth,
  lastProbeAt: number | undefined,
  startedAt: number,
): number {
  const interval = lane === "deepseek" ? DEEPSEEK_MIN_INTERVAL_MS : PROBE_INTERVAL_MS;
  const resets = rec.resets_at ? Date.parse(rec.resets_at) : NaN;
  let due: number;
  if (!Number.isNaN(resets)) {
    const afterReset = resets + AFTER_RESET_MS;
    due = lastProbeAt === undefined || lastProbeAt < afterReset ? afterReset : lastProbeAt + interval;
  } else {
    due = (lastProbeAt ?? startedAt) + interval;
  }
  if (lane === "deepseek" && lastProbeAt !== undefined) {
    due = Math.max(due, lastProbeAt + DEEPSEEK_MIN_INTERVAL_MS);
  }
  return due;
}

function probeBody(lane: ProviderKey): AnthropicRequest {
  return {
    model: fast(lane),
    max_tokens: 16,
    stream: true,
    messages: [{ role: "user", content: "Reply with OK." }],
  } as AnthropicRequest;
}

// The adapters write Anthropic SSE into res.raw; a probe only cares whether the adapter
// reached markLaneOk, so the output goes nowhere.
function sinkReply(): FastifyReply {
  const raw = {
    writableEnded: false,
    headersSent: false,
    setHeader: () => {},
    removeHeader: () => {},
    flushHeaders: () => {},
    write: () => true,
    end: () => {
      raw.writableEnded = true;
    },
  };
  return { raw } as unknown as FastifyReply;
}

const lastProbe = new Map<ProviderKey, number>();
const inFlight = new Set<ProviderKey>();

async function probeLane(lane: ProviderKey, rec: LaneHealth): Promise<void> {
  const fn = PROBES[lane];
  if (!fn) return;
  inFlight.add(lane);
  lastProbe.set(lane, Date.now());
  console.log(`[probe] ${lane}: probing (down since ${rec.detected_at}: ${rec.reason})`);
  let error = "";
  try {
    await withRecoveryReason("probed-200", () =>
      Promise.race([
        fn(sinkReply(), probeBody(lane)),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("probe timed out")), PROBE_TIMEOUT_MS).unref(),
        ),
      ]),
    );
  } catch (e: any) {
    error = String(e?.message || e).slice(0, 200);
  } finally {
    inFlight.delete(lane);
  }
  const after = laneHealth(lane);
  if (after?.status === "ok") {
    console.log(`[probe] ${lane}: recovered (probed-200)`);
  } else {
    console.log(
      `[probe] ${lane}: still down (${after?.reason ?? rec.reason})${after?.resets_at ? ` resets_at=${after.resets_at}` : ""}${error ? ` ${error}` : ""}`,
    );
  }
}

let timer: NodeJS.Timeout | undefined;

/** Start the probe loop. Idempotent; a no-op when CCX_LANE_PROBE=0. */
export function startLaneProbes(): void {
  if (timer || process.env.CCX_LANE_PROBE === "0") return;
  const tickMs = Number(process.env.CCX_LANE_PROBE_TICK_MS) || MINUTE;
  const startedAt = Date.now();
  const tick = () => {
    try {
      const now = Date.now();
      for (const [lane, rec] of downLanes()) {
        if (!PROBES[lane] || inFlight.has(lane)) continue;
        if (now >= nextProbeAt(lane, rec, lastProbe.get(lane), startedAt)) {
          void probeLane(lane, rec);
        }
      }
    } catch (e: any) {
      // The probe is best-effort; it must never take the proxy with it.
      console.error(`[probe] tick failed: ${e?.message || e}`);
    }
  };
  timer = setInterval(tick, tickMs);
  timer.unref();
}
