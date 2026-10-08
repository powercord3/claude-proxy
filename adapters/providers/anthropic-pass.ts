// Pass-through adapter for Anthropic-compatible upstreams (Anthropic API and Z.AI GLM)
import { FastifyReply } from "fastify";
import type { ReasoningLevel } from "../types.js";

type PassArgs = {
  res: FastifyReply;
  body: any;
  model: string;
  baseUrl: string;
  headers: Record<string, string>;
  /** Explicit stream preference. Defaults to the incoming body's `stream`. */
  stream?: boolean;
  /**
   * Don't flush SSE headers on the upstream's 200; let the first body write carry them. Set
   * by the gateway while a fallback hop still exists, so an upstream that dies before its
   * first chunk leaves the reply untouched and the next target can take over.
   */
  deferHeaders?: boolean;
  /**
   * Effort parsed from the model string's @suffix. Undefined when the caller named no
   * suffix, and undefined MUST mean "change nothing" - see applyReasoning().
   */
  reasoning?: ReasoningLevel;
};

// -- Reasoning effort -------------------------------------------------
//
// Every other provider in this fork reads the @suffix and turns it into a real reasoning
// parameter; this adapter did not, so an Anthropic model carried no effort at all. Claude
// Code's own per-subagent `effort:` does not reach the wire either (measured: four runs,
// low against max, identical output tokens), which left Claude-family agents with no effort
// control anywhere in the stack. This restores the suffix as the one lever that works.
//
// The translation is model-dependent, and getting it wrong is a 400 rather than a
// degradation, so the two families are kept apart deliberately:
//
//   EFFORT_MODELS   `output_config.effort` is GA. `thinking.budget_tokens` is REMOVED on
//                   these and returns a 400 - Opus 5, Sonnet 5, Opus 4.8/4.7 all reject it.
//   BUDGET_MODELS   pre-effort models where `output_config.effort` itself errors, and
//                   `thinking: {type:"enabled", budget_tokens:N}` is the only form.
//
// Both families are live here: agent-review resolves to Sonnet 5 (effort) and agent-verify
// to Haiku 4.5 (budget). One rule for both would 400 on one of them.
//
// Anything matching neither is left untouched. An unrecognised model is far likelier to be
// newer than this table than to want a guess, and a wrong guess fails the request outright -
// so unknown means do nothing, the same rule strip-model.py follows for unparseable pins.
const EFFORT_MODELS =
  /^claude-(opus-5|fable-5|mythos-5|sonnet-5|haiku-5|opus-4-8|opus-4-7|opus-4-6|sonnet-4-6|opus-4-5)/;
const BUDGET_MODELS = /^claude-(haiku-4-5|sonnet-4-5|opus-4-1|opus-4-0|sonnet-4-0)/;

// `xhigh` arrived with Opus 4.7, so on the 4.6/4.5 generation it is not a valid level; `max`
// is valid on 4.6 but not on Opus 4.5. Clamping down beats forwarding a level the upstream
// rejects, because a rejected level is a dead request rather than a slower one.
const NO_XHIGH = /^claude-(opus-4-6|sonnet-4-6|opus-4-5)/;
const NO_MAX = /^claude-opus-4-5/;

// Thinking cannot be switched off on Fable/Mythos - an explicit {type:"disabled"} is a 400
// there, and omitting the field is the only way to express it.
const NO_DISABLE = /^claude-(fable-5|mythos-5)/;

// Level -> thinking budget, for the models that take a token count instead of a level.
// Anthropic's floor is 1024 and the budget must be strictly below max_tokens; both are
// enforced in planReasoning(), because only it can see the request's own ceiling.
const BUDGETS: Record<string, number> = {
  low: 2048,
  medium: 6144,
  high: 12288,
  xhigh: 24576,
  max: 32768,
};

const MIN_BUDGET = 1024;

export type ReasoningPlan =
  | { kind: "skip" }
  | { kind: "effort"; effort: string }
  | { kind: "budget"; budgetTokens: number }
  | { kind: "disabled" };

/**
 * Decide what a given @suffix means for a given model. Pure, so it can be tested without a
 * network call - which matters because every wrong answer here is a 400, not a nuance.
 */
export function planReasoning(
  model: string,
  level: ReasoningLevel | undefined,
  maxTokens: number | undefined,
): ReasoningPlan {
  if (!level) return { kind: "skip" }; // no suffix -> behave exactly as before

  const off = level === "none" || level === "minimal";

  if (EFFORT_MODELS.test(model)) {
    if (off) {
      // There is no effort level below `low`, so both collapse to thinking-off - the same
      // normalisation deepseek.ts already applies on its own side.
      return NO_DISABLE.test(model) ? { kind: "skip" } : { kind: "disabled" };
    }
    let effort: string = level;
    if (effort === "xhigh" && NO_XHIGH.test(model)) effort = "high";
    if (effort === "max" && NO_MAX.test(model)) effort = "high";
    return { kind: "effort", effort };
  }

  if (BUDGET_MODELS.test(model)) {
    if (off) return { kind: "disabled" };
    let budget = BUDGETS[level];
    if (!budget) return { kind: "skip" };
    // budget_tokens must be strictly less than max_tokens. A ceiling that leaves no room
    // for the floor cannot think at all, and asking anyway is a 400 - so that case turns
    // thinking off rather than sending a pair that cannot be satisfied.
    if (typeof maxTokens === "number" && maxTokens > 0) {
      const ceiling = maxTokens - 1;
      if (ceiling < MIN_BUDGET) return { kind: "disabled" };
      if (budget > ceiling) budget = ceiling;
    }
    if (budget < MIN_BUDGET) budget = MIN_BUDGET;
    return { kind: "budget", budgetTokens: budget };
  }

  return { kind: "skip" }; // unknown model: never guess
}

/**
 * Apply a plan to the outbound body in place. Returns a short label for the log line.
 *
 * Sampling parameters are dropped whenever a thinking budget is set: extended thinking
 * constrains temperature/top_p/top_k on the models that still accept them. A caller that
 * set one and then asked for effort would otherwise get a 400 that reads as though the
 * suffix itself were at fault.
 */
/**
 * Remove `output_config.effort` from a request body, returning whether anything
 * was removed. Shared by the `budget` and `skip` branches so the two cannot
 * drift apart again - they had, and the gap was a 400 on every unsuffixed alias
 * pointing at a budget-family model.
 *
 * Drops `output_config` entirely when effort was its only key, rather than
 * leaving an empty object behind.
 */
function stripEffort(body: any): boolean {
  if (!body?.output_config || !("effort" in body.output_config)) return false;
  const { effort: _dropped, ...rest } = body.output_config;
  if (Object.keys(rest).length) body.output_config = rest;
  else delete body.output_config;
  return true;
}

export function applyReasoning(
  body: any,
  model: string,
  level: ReasoningLevel | undefined,
): string | undefined {
  const plan = planReasoning(model, level, body?.max_tokens);
  switch (plan.kind) {
    case "skip":
      // A skip means "no suffix-derived instruction", NOT "this body is safe to
      // forward untouched". Claude Code forwards each subagent's frontmatter
      // effort, so an unsuffixed alias pointing at a budget-family model ships a
      // field that model treats as an error - measured as a 400 on
      // `housekeeping` -> claude-haiku-4-5 with effort=high, 2026-08-17. The
      // budget branch below has always stripped it; doing it only there made the
      // sanitisation depend on whether the alias happened to carry a suffix,
      // which is unrelated to whether the upstream supports the field.
      //
      // Deliberately gated on BUDGET_MODELS. `skip` is also the unknown-model
      // path, and the rule there is to never guess: a model this table does not
      // recognise is likelier to be newer than it is to want its body edited.
      if (BUDGET_MODELS.test(model) && stripEffort(body)) {
        return "effort stripped (unsupported on this model)";
      }
      return undefined;
    case "disabled": {
      body.thinking = { type: "disabled" };
      // Claude Code ships a `clear_thinking_20251015` context-management strategy, and that
      // strategy is only valid while thinking is enabled - turning thinking off underneath it
      // is a 400, not a quieter request. Measured, not predicted: @none and @minimal both
      // failed this way before this line existed. Drop only the thinking-related edits and
      // leave any others, since context management is the client's setting, not ours.
      const cm = body.context_management;
      if (cm && Array.isArray(cm.edits)) {
        const kept = cm.edits.filter(
          (e: any) => !String(e?.type ?? "").startsWith("clear_thinking"),
        );
        if (kept.length !== cm.edits.length) {
          if (kept.length) body.context_management = { ...cm, edits: kept };
          else delete body.context_management;
        }
      }
      // On Opus 5 a disabled-thinking request is accepted only at effort `high` or below;
      // pairing it with xhigh/max is a 400. The client sets that effort, not us - ultracode
      // sends xhigh - so an alias asking for thinking-off would otherwise produce a dead
      // request out of two individually valid settings. Clamp rather than refuse: the
      // suffix is the more specific instruction, and it was set for this agent.
      const eff = body.output_config?.effort;
      if (eff === "xhigh" || eff === "max") {
        body.output_config = { ...body.output_config, effort: "high" };
        return "thinking=off (effort clamped to high)";
      }
      return "thinking=off";
    }
    case "effort":
      body.output_config = { ...(body.output_config || {}), effort: plan.effort };
      return `effort=${plan.effort}`;
    case "budget":
      body.thinking = { type: "enabled", budget_tokens: plan.budgetTokens };
      // These models predate `output_config.effort` and it is documented as an error on
      // them. The client sends one anyway - Claude Code forwards each subagent's frontmatter
      // effort - so leaving it in place bets the request on the upstream tolerating a field
      // it never supported. The budget carries the same intent, so drop the effort rather
      // than ship both.
      stripEffort(body);
      delete body.temperature;
      delete body.top_p;
      delete body.top_k;
      return `budget=${plan.budgetTokens}`;
  }
}

/**
 * Pass through requests to Anthropic-compatible APIs
 * This works for both:
 * - Anthropic's official API
 * - Z.AI's GLM API (Anthropic-compatible)
 */
export async function passThrough({
  res,
  body,
  model,
  baseUrl,
  headers,
  stream,
  reasoning,
  deferHeaders,
}: PassArgs) {
  const url = `${stripEndSlash(baseUrl)}/v1/messages`;

  // Replace model with parsed model name (strips provider prefix like "glm:" or "anthropic:")
  body.model = model;
  const applied = applyReasoning(body, model, reasoning);
  if (applied) console.log(`[ccx] REASONING: model="${model}" -> ${applied}`);
  // Anthropic's convention: stream only when explicitly asked. Claude Code's
  // /model validation probe omits the field and sends Accept: application/json,
  // so unconditionally forcing stream:true here hands it SSE where it expects a
  // single JSON body, and model selection fails.
  const wantsStream = stream ?? body.stream === true;
  body.stream = wantsStream;

  const resp = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body)
  });

  // Claude Code reads its 5h / 7d usage (the status line's `rate_limits`
  // block, and the /usage screen) from the `anthropic-ratelimit-unified-*`
  // response headers. Rebuilding the response here dropped them, so the CLI
  // never learned the numbers and the status line showed nothing. Done before
  // the status check so a 429 carries its headers too: the gateway's catch
  // replies through Fastify, and Node merges these into that writeHead.
  forwardUpstreamHeaders(resp, res);

  if (!resp.ok || !resp.body) {
    const text = await safeText(resp);
    const err = new Error(`Upstream error (${resp.status}): ${text}`);
    // @ts-ignore
    err.statusCode = resp.status || 502;
    throw err;
  }

  if (!wantsStream) {
    const text = await resp.text();
    res.raw.setHeader("Content-Type", "application/json");
    res.raw.end(text);
    return;
  }

  // Pipe upstream SSE as-is (already in Anthropic format)
  res.raw.setHeader("Content-Type", "text/event-stream");
  res.raw.setHeader("Cache-Control", "no-cache, no-transform");
  res.raw.setHeader("Connection", "keep-alive");
  // @ts-ignore
  if (!deferHeaders) res.raw.flushHeaders?.();

  const reader = resp.body.getReader();
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    res.raw.write(value);
  }
  res.raw.end();
}

/**
 * Copy the upstream headers the client actually consumes onto our response.
 * Only the rate-limit family and the request id: content-length / encoding /
 * transfer-encoding must NOT be copied, since we re-emit the body ourselves.
 */
function forwardUpstreamHeaders(resp: Response, res: PassArgs["res"]) {
  let forwarded = 0;
  resp.headers.forEach((value, name) => {
    const n = name.toLowerCase();
    if (n.startsWith("anthropic-ratelimit-") || n === "request-id" || n === "retry-after") {
      try {
        res.raw.setHeader(name, value);
        forwarded++;
      } catch {
        // headers already sent - nothing to do
      }
    }
  });
  const h5 = resp.headers.get("anthropic-ratelimit-unified-5h-utilization");
  const h7 = resp.headers.get("anthropic-ratelimit-unified-7d-utilization");
  console.log(`[ccx] RATELIMIT: forwarded=${forwarded} 5h=${h5 ?? "-"} 7d=${h7 ?? "-"}`);
}

function stripEndSlash(s: string) {
  return s.endsWith("/") ? s.slice(0, -1) : s;
}

async function safeText(resp: Response) {
  try {
    return await resp.text();
  } catch {
    return "<no-body>";
  }
}
