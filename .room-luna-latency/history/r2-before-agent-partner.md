# Plan: why luna@max is ~4x slower than opus@medium through the proxy, and what is fixable

Partner revision, 2026-09-05. Everything in §1–§2 is MEASURED this session (Claude Code
subagent transcripts with timestamps, mitm-route.log timestamps, proxy.log.fallback fields).
§3 onward distinguishes code-established mechanisms from hypotheses.

## 1. The A/B (identical `scout` definition, byte-identical brief, only the alias moved)

| | luna@max | sonnet@high | opus@medium |
|---|---|---|---|
| wall-clock | 209.9 s | 55.8 s | 53.0 s |
| tool calls | 11 | 10 | 11 |
| requests seen by proxy | 16 | (Anthropic lane logs no cache) | – |
| answer correct | yes (101 defs) | yes | yes |

Work order §2 predicted this: "luna@medium 9.6 s/tool-call vs luna@max 29.9 s/tool-call; on
public benchmarks luna@max is slightly faster than Opus, so the gap is our overhead."
Today: luna@max 19.1 s/tool-call.

## 2. Where luna's 210 s went (subagent transcript timestamps)

| phase | luna@max | opus@medium | sonnet@high |
|---|---|---|---|
| 10 file Reads | 36.3 s in **10 serial turns, one tool per turn**, 2–4 s each | 9.5 s in 5 turns (several tool_use per turn) | 7.7 s in 4 turns |
| pre-final Grep turn | **61.8 s**; output_tokens=3347, summary 839 chars | 4.5 s | – |
| final report | **107.4 s** (69.6 s to first summary text, 37.8 s streaming 6112 chars); output_tokens=5883 | 39 s | 48 s |

Generation throughput on luna, both big requests: ~55 tok/s (output_tokens incl. reasoning /
wall-clock, measured at the Claude Code side, so it includes both proxy hops).

Other measured facts:
- `parallel_tool_calls: false` is hard-coded (adapters/providers/codex-oauth.ts:940) with no
  comment justifying it.
- `cacheRead` = 3712 on 13/16 requests, 12928 on 3 (turns 6, 13, 15). `sentKey`, `sentInstrHash`
  and `firstUserRawHash` are constant on all 16 (fixes A+B1 hold), so the miss is not in
  instructions or key.
- prefix-probe per turn: stableItems 4/8, 7/11, 10/14, 13/17, 16/20 — on every turn the trailing
  ~4 items of the previous request change, firstDiff at the previous turn's `function_call`.
  `cache=1 reasoningItems=1` on those turns: only the last turn's reasoning item is replayed
  (B2: `reasoningItemsByKey(reasoningKeyForCallIds(lastAssistantToolCallIds))`,
  codex-oauth.ts:911–914; codex-reasoning-cache.ts:202), so the previous turn's reasoning item is
  removed from the middle of the sequence each turn. Turns 8–13 had no reasoning (cache=0) and
  stableItems jumped to 24/25, 30/31.
- The three 12928 hits each immediately follow a concurrent request with the same prefix
  (Claude Code's "Describe your most recent action in 3-5 words" side-call).
- Those side-calls: 3 per run, sent under the subagent's alias → luna@max with the full
  transcript (reqKiB 142–197). One returned a 5,517-char full report (output_tokens=5846) after
  the client had disconnected (mitm: `Client disconnected` 22:10:28 and 22:11:05).
- The gateway has no client-abort propagation: no `req.on("close")`, no AbortSignal passed to
  fetch, in anthropic-gateway.ts or codex-oauth.ts. Upstream runs to completion after a hangup.
- No per-request timing is logged anywhere in the gateway. `ms=` does not exist; only
  mitm-route.log carries timestamps.
- Fast mode (`service_tier: priority`, `!fast` marker) is OFF on every alias.
- store:false; per-request diagnostic probes hash ~200 KB (shell-probe, prefix-probe, p0-system).

## 3. Findings and hypotheses, ranked by expected recoverable wall time

### H2 — max-effort output and hidden reasoning: rank 1

**APPLY — retain as the leading hypothesis, but narrow the claim.** The 61.8 s pre-final turn
and 107.4 s final turn dominate the run. However, the former also emitted 3347 output tokens at
the measured ~55 tok/s, so it is not evidence for 62 seconds of silent reasoning by itself.
The 69.6 s before the final turn's first summary text is the cleaner evidence for a large hidden
reasoning interval. `effectiveReasoningEffort` passes ordinary requests through unchanged
(adapters/providers/codex-oauth.ts:434-440), and the chosen effort is sent at
adapters/providers/codex-oauth.ts:941.

Expected opportunity: largest, plausibly 60–100 s, but lowering effort changes the requested
quality tier and must be judged on answer quality as well as latency.

### H1 — serial tool turns: rank 2

**APPLY — classify `parallel_tool_calls:false` as an unjustified default, not a correctness
invariant.** The request-body comment merely says the shape matches Codex's request type
(adapters/providers/codex-oauth.ts:933-946). The converter emits every `tool_use` as a
`function_call` and every result as a same-ID `function_call_output`
(adapters/providers/codex-oauth.ts:348-392). Streaming keeps independent call state in a map
(adapters/providers/codex-oauth.ts:1189-1203,1483-1530), closes each completed call
(adapters/providers/codex-oauth.ts:1537-1561), and keys reasoning on the full call-ID tuple
(adapters/codex-reasoning-cache.ts:186-199).

Two calls followed by two results therefore produce valid Responses input; no line fails merely
because there are two. The untested edge is upstream event ordering: if a second
`response.output_item.added` arrives before the first call's done event, the handler starts the
second Anthropic block without first closing the first (adapters/providers/codex-oauth.ts:1483-1512).
Test that event sequence before making the flag permanent.

Expected opportunity: material but below H2. The observed 26.8 s Read-phase difference is an
upper bound, not a measured saving, because it also compares luna with opus.

### H4 — reasoning replay breaks append-only history: rank 3

**APPLY — confirm the mechanism but reject the claimed extent and causal certainty.** Lookup
retrieves only the last assistant turn's reasoning tuple (adapters/providers/codex-oauth.ts:904-916),
and `toResponsesInput` inserts it before that turn (adapters/providers/codex-oauth.ts:398-416).
On the next `cache=1` request that item disappears from its former position.

It is false that the common prefix consequently ends before the conversation's first
`function_call`: measured stableItems advances 4 → 7 → 10 → 13 → 16. It ends before the
*previous request's final assistant turn*. It is also false that removal occurs on every turn;
turns 8–13 had `cache=0`.

This establishes a non-append-only suffix, but does not by itself explain `cacheRead` remaining
3712 while the stable prefix grows. The 12928 hits after same-prefix side-calls are consistent
with cache warming/admission by those calls, not unique evidence for the reasoning-removal
explanation.

Expected opportunity: likely TTFT savings over repeated turns, but unquantified and probably
below H1 until falsified experimentally.

### H5 — orphaned side-calls: rank 4

**APPLY — retain as proven resource waste; reject a proven critical-path saving.** The provider
passes a fetch request with no signal (adapters/providers/codex-oauth.ts:1135-1139), and the SSE
pump continues reading until upstream completion or an upstream read failure
(adapters/providers/codex-oauth.ts:1345-1370). That matches the measured post-disconnect work.
Whether concurrent generation slows the main request through account-level contention is not
measured.

### H3 — local pipeline versus backend throughput: rank 5

**APPLY — lower its prior probability and split local forwarding from backend choice.** The
provider's streaming path is a linear `reader.read`/parser loop
(adapters/providers/codex-oauth.ts:1345-1352), and the mitm explicitly turns on streaming for SSE
responses (mitm/route_anthropic.py:252-283). There is no code evidence for 60 seconds of local
buffering.

OAuth and API-key lanes are different upstreams: OAuth selects
`https://chatgpt.com/backend-api/codex/responses`, while an API key selects
`https://api.openai.com/v1/responses` (adapters/providers/codex-oauth.ts:46-47,870-885).
A direct comparison is useful only when the backend, account, effort, tier, summary, verbosity,
and serialized input are controlled.

### H6 — missing instrumentation: rank 6 for direct recovery, rank 1 as an enabler

**APPLY.** The only completion line reports counts, not elapsed boundaries
(adapters/providers/codex-oauth.ts:1396-1405). Instrumentation itself saves no wall time, but it
is necessary to distinguish local preprocessing, upstream queue/TTFT, silent reasoning,
visible generation, and downstream forwarding.

## 4. Request-path findings the original plan omitted

- **APPLY — measure the mitm hop, do not presume it buffers.** It rewrites routed POSTs to the
  local gateway (mitm/route_anthropic.py:325-343), and explicitly streams event-stream responses
  (mitm/route_anthropic.py:252-283).
- **APPLY — measure gateway preprocessing.** The gateway hashes each system block and rebuilds
  flattened metadata before dispatch (adapters/anthropic-gateway.ts:438-468), then strips web
  tools and appends a native-search instruction (adapters/anthropic-gateway.ts:427-473;
  adapters/web-search-substitution.ts:15-33).
- **APPLY — include credential/file I/O in pre-fetch timing.** OAuth token loading rereads proxy
  or CLI token files on every request (adapters/openai-auth.ts:53-92,152-185). Account ID and
  installation ID add synchronous reads (adapters/openai-auth.ts:125-148;
  adapters/providers/codex-oauth.ts:78-84,980-998).
- **APPLY — isolate diagnostic CPU.** The adapter serializes the full request once
  (adapters/providers/codex-oauth.ts:1000-1001), then serializes and hashes items, instructions,
  tools, and the stable prefix again (adapters/providers/codex-oauth.ts:1034-1083). The code
  identifies work, not a seconds-scale cost; time it before optimizing it.
- **EXPERIMENT — `reasoning.summary`.** It defaults to `auto` unless explicitly set to `none`
  (adapters/providers/codex-oauth.ts:443-447) and is added to every reasoning request
  (adapters/providers/codex-oauth.ts:941). Test `auto` versus `none` after H1/H2.
- **REJECT — treating `text.verbosity` as active without evidence.** The field is omitted unless
  the environment contains low/medium/high (adapters/providers/codex-oauth.ts:450-453,947).
  Log its effective value first.
- **REJECT — changing only `store:false` as a payload fix.** The adapter always constructs the
  full `input` and serializes it (adapters/providers/codex-oauth.ts:916,934-945,1000). With no
  previous-response reference, `store:true` alone would upload the same bytes while changing
  retention semantics.

## 5. Actions in execution order

### A0. Timing instrumentation

**APPLY.** Add one request ID and monotonic timestamps for gateway receipt, adapter entry,
auth complete, conversion/probes complete, fetch start, upstream headers, first upstream SSE,
first reasoning delta, first text delta, stream completion, and client close. Log request bytes,
effective summary/verbosity/tier, and whether diagnostics are enabled. Existing finalization is
where cache usage becomes available (adapters/providers/codex-oauth.ts:1373-1405).

### A1. Parallel-call paired A/B — first experiment

**EXPERIMENT.** Put `parallel_tool_calls` behind an explicit gate and add:

1. A conversion test containing two `tool_use` blocks and two matching `tool_result` blocks.
2. A stream test containing two function calls, including the most aggressive legal upstream
   event ordering.
3. Three alternating runs of the identical scout task with the flag false/true, recording Read
   turns, calls per assistant response, correctness, TTFT, and wall time.

Falsifier/drop rule: if enabled runs still use one call per assistant response and retain ten
serial Read turns, with no repeatable wall reduction, drop H1 for this task. Any upstream 400 or
malformed Anthropic stream blocks permanent enablement until its exact event is reproduced.

### A2. Effort A/B

**EXPERIMENT.** After A1, run the identical task at luna@max and luna@medium with the same
parallel setting. Record hidden interval to first reasoning delta, output tokens, visible text,
correctness, and wall time. Do not call lower effort an overhead fix if answer quality regresses.

### A3. Cache-mechanism falsification

**EXPERIMENT.** Run a clean serial task with `CCX_DISABLE_REASONING_CACHE=1`, side-calls excluded,
and stable instructions/tools/key. Confirm the prior request is a complete item prefix of the
next. Once that stable prefix exceeds 12928 tokens, two further requests remaining at
`cacheRead=3712` falsify reasoning-item removal as the sufficient cause.

If cache reads grow, redesign replay to retrieve reasoning for every historical assistant
call-ID tuple and insert each item before the assistant turn that produced it. The cache already
stores response reasoning under emitted call-ID tuples
(adapters/providers/codex-oauth.ts:1382-1394; adapters/codex-reasoning-cache.ts:228-249).
Test eviction/TTL behavior, because losing an old item would again remove data from the middle.

### A4. Client-abort propagation

**APPLY.** Connect premature downstream close to an `AbortController` supplied to the upstream
fetch, while distinguishing normal response completion. Test disconnect before headers, during
reasoning, during text, and after normal completion. This directly stops the measured orphaned
request; any wall-time benefit to concurrent work remains an experiment.

### A5. Side-call routing

**EXPERIMENT.** Only after abort propagation, classify the measured action-description side-call
using its full structural signature plus exact generated prompt, not prompt text alone. Route it
to `housekeeping` in an A/B and verify it still returns the required short answer. Reject a broad
substring detector because it can capture a genuine user request.

### A6. Summary, verbosity, tier, backend, and proxy-hop decomposition

**EXPERIMENT.** Run separate one-variable comparisons:

- `reasoning.summary:auto` versus `none`;
- effective default verbosity versus `low`, only if verbosity is actually configured;
- standard versus priority tier, reporting its cost/credit tradeoff;
- mitm route versus direct local gateway using the same serialized request;
- proxy versus direct upstream using the same ChatGPT OAuth backend and raw request.

Do not use `codex exec` as the primary pipeline control unless its emitted request is shown to
match; otherwise client defaults and conversation state are confounders.

### A7. Default-agent policy

**REJECT for now.** Do not demote luna@max solely from a one-run latency sample. Reconsider the
default only after paired effort tests quantify both latency and answer-quality changes.

## 6. Known weak points and decision boundaries

- One run per lane remains insufficient for small differences; paired repeats are required.
- H1's 26.8 s is a cross-model upper bound, not recovered time.
- H4's sequence mutation is code-established, but its responsibility for 3712 cache reads is not.
- The 12928 side-call correlation supports warming/admission but does not establish server cache
  policy.
- The measured ~55 tok/s is end-to-end; new timing must separate upstream silence, upstream
  generation, and local forwarding.
- Side-call waste is proven; account-level contention is not.
- The public benchmark claim remains unverified and should not be used in a decision.
