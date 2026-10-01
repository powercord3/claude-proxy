# Discussion — Why luna@max runs ~4x slower than opus@medium through the proxy on an identical agentic task, and which of the measured overheads are fixable

Opened 2026-09-06T03:32:50Z. Cap: 4 rounds.
Members, in speaking order: agent-partner.

Extend past the cap only on new evidence, a concrete counterexample, or a bounded
falsifiable proposal that the NEXT round would carry — never because disagreement
remains.


---

## Round 1 — orchestrator

Round 1 brief.

Read plan.md in this directory first. It contains this session's measurements; do not re-derive
them, attack them. Then read the code it cites before answering. Cite file:line for every claim
about code.

Q1. `parallel_tool_calls: false` (adapters/providers/codex-oauth.ts:940). Read the surrounding
    comment and the tool_use/function_call round-trip (toResponsesInput, handleEvent, finalize).
    Is the flag load-bearing for correctness, or an inherited default? If Claude Code emits two
    tool_use blocks in one assistant turn and gets two tool_results back, does the current
    conversion produce a valid Responses input? If not, what breaks, and at which line?

Q2. H4. Read codex-reasoning-cache.ts (reasoningItemsByKey, setReasoningItemsByKey,
    reasoningKeyForCallIds) and toResponsesInput. Confirm or refute: replaying only the last
    turn's reasoning items removes an item from the middle of the serialized `input` on every
    turn, so the longest byte-identical prefix with the previous request ends before the first
    function_call. If true, does that explain cacheRead pinned at 3712 (≈ instructions + tools)
    and the 12928 hits that follow a same-prefix side-call? State the minimal experiment that
    would falsify this, and what result would falsify it.

Q3. Rank H1–H6 by expected wall-clock recovered on THIS task, with your reasoning. Which single
    experiment should run first, and what outcome would make you drop it?

Q4. What in the request path did the orchestrator miss? Consider: two proxy hops (mitm →
    gateway), the three per-request probes hashing ~200 KB, store:false, reasoning.summary,
    text.verbosity, the ChatGPT backend vs the API, and anything in chatCodexOAuth before the
    upstream fetch. Only name things you can point at in code.

Return a full revised plan.md as your staged proposal (keep §1–§2 measurements verbatim unless
you can show a number is wrong), and mark each change as APPLY / REJECT / EXPERIMENT with
grounds.

## Round 1 — agent-partner

## Q1 — the flag is not load-bearing

`parallel_tool_calls: false` has no local correctness rationale; the surrounding comment only says the body matches Codex’s request type (adapters/providers/codex-oauth.ts:933-946). The conversion already supports plural calls: every `tool_use` becomes a top-level `function_call`, every `tool_result` becomes a `function_call_output` with the same ID, and all trailing items are appended (adapters/providers/codex-oauth.ts:348-392). Streaming tracks calls independently by item ID and block index (adapters/providers/codex-oauth.ts:1483-1512,1519-1530,1537-1561), while the reasoning key deliberately handles a tuple of call IDs (adapters/codex-reasoning-cache.ts:186-199).

Thus two calls followed by two matching results serialize as a valid sequence: `call1, call2, output1, output2`. No conversion line breaks. What remains unproved is SSE event ordering when parallel calls are actually enabled: if the backend opens call 2 before closing call 1, lines 1506-1511 emit overlapping Anthropic content blocks. That deserves a two-call stream test, but it does not justify permanently disabling parallel calls.

## Q2 — the proposed H4 statement is too strong

A cached item is retrieved only for the last assistant turn’s call-ID tuple (adapters/providers/codex-oauth.ts:904-916), then inserted before that last assistant turn (adapters/providers/codex-oauth.ts:398-416). On the next turn, the former reasoning item is therefore absent from its old position. That mechanism is real on `cache=1` turns.

But it does not make the common prefix end before the conversation’s first function call, nor does it happen “on every turn.” The measurements themselves show the stable prefix advancing 4, 7, 10, 13, 16 items, and turns 8–13 had no injected reasoning. The divergence is before the *previous request’s last assistant function call*, after all older turns. Consequently, this mechanism alone does not explain why `cacheRead` stays exactly 3712 despite a growing stable prefix. The 12928 hits after same-prefix side-calls are consistent with those calls warming/admitting a deeper prefix, but do not uniquely prove reasoning removal caused the ordinary misses.

Minimal falsifier: run the same serial task with `CCX_DISABLE_REASONING_CACHE=1`, suppress side-calls, and verify from the prefix probe that each request is append-only. Once the independently measured stable prefix exceeds 12928 tokens, two subsequent completed requests that still report `cacheRead=3712` falsify reasoning-item removal as the sufficient cause.

## Q3 — ranking and first experiment

Expected recoverable wall time on this task: H2 > H1 > H4 > H5 > H3 > H6.

- H2 has the largest measured opportunity, although lowering effort changes the requested quality tier. The two long turns dominate the run.
- H1 is next, but 27 seconds is an upper bound, not a measured saving: 36.3 versus 9.5 seconds compares different models as well as different turn counts.
- H4 has a demonstrated sequence defect but an unproved cache-latency effect.
- H5 demonstrably wastes upstream work; critical-path contention remains unmeasured.
- H3 is unlikely to be 60 seconds of local forwarding overhead: the gateway consumes upstream chunks in a simple read loop (adapters/providers/codex-oauth.ts:1345-1352), and mitm explicitly enables SSE streaming (mitm/route_anthropic.py:252-283). It still needs timing evidence.
- H6 recovers no time itself but is prerequisite instrumentation.

The first experiment should be the paired `parallel_tool_calls` A/B because it preserves `luna@max` semantics and tests a direct, reversible lever. Drop H1 if enabling it produces no multi-call turns and does not reduce the ten serial Read turns across repeated paired runs.

## Q4 — missed request-path work

The plan missed several measurable boundaries and one faulty causal attribution:

- The mitm hop rewrites the request to the local gateway (mitm/route_anthropic.py:325-343) but explicitly streams SSE (mitm/route_anthropic.py:252-283); bypass it in a timing A/B, but buffering is not supported by the code.
- Before routing, the gateway hashes every system block and rebuilds flattened metadata (adapters/anthropic-gateway.ts:438-468), then mutates tools/system for native search (adapters/anthropic-gateway.ts:427-473; adapters/web-search-substitution.ts:15-33).
- OAuth handling rereads token files on every request (adapters/openai-auth.ts:53-92,152-185); account ID and installation ID add synchronous file reads (adapters/openai-auth.ts:125-148; adapters/providers/codex-oauth.ts:78-84,980-998).
- The adapter serializes the full body (adapters/providers/codex-oauth.ts:1000-1001), then repeatedly serializes/hashes items, tools, instructions, and stable items for diagnostics (adapters/providers/codex-oauth.ts:1034-1083). These are likely milliseconds, not seconds, but current logs cannot prove that.
- `reasoning.summary` defaults to `auto` and is sent on every request unless explicitly disabled (adapters/providers/codex-oauth.ts:443-447,941). `text.verbosity` is only sent when configured (adapters/providers/codex-oauth.ts:450-453,947). They need to be logged and tested separately.
- OAuth uses the ChatGPT backend while API-key requests use the API endpoint (adapters/providers/codex-oauth.ts:870-885). A `codex exec` comparison is invalid unless backend, account, request fields, effort, summary, and tier are matched.
- `store:false` does not itself cause full-history upload. This adapter always places the complete converted `input` in the request and serializes it (adapters/providers/codex-oauth.ts:916,934-945,1000). Changing only `store` would retain the same payload because the adapter supplies no previous-response reference.

**Disagreements**

- H4 does not move the common prefix before the conversation’s first function call; measured stableItems grows by three each turn, so divergence is before the previous request’s last assistant turn.
- The reasoning-item mutation is not yet a sufficient explanation for cacheRead=3712; same-prefix side-calls implicate cache warming/admission behavior that the current plan does not distinguish.
- The 26.8-second Read-phase gap is not measured recoverable H1 time because it compares luna against opus as well as ten turns against five.
- `parallel_tool_calls:false` is not shown to protect correctness; plural call/result conversion and call-ID tuple handling are already implemented.
- Changing `store:false` alone would not stop history upload because the adapter always sends the full `input` and uses no previous-response reference.
- A `codex exec` comparison is confounded unless its backend and serialized request fields match the proxy’s ChatGPT OAuth request.
- The 61.8-second pre-final turn is not wholly a silent reasoning burst; it emitted 3347 output tokens at approximately the measured 55 tok/s.

**Wants another round:** yes — I hold a BOUNDED FALSIFIABLE PROPOSAL for the next round: carry the paired parallel-tool-call experiment result, including actual upstream event ordering and whether Read turns fall below ten. That evidence would decide whether H1 survives.

## Round 1 — orchestrator's ruling

Ruling, round 1 (orchestrator).

APPLIED the staged plan in full as plan.md. Specifically accepted:

- H4 narrowed: the stable prefix advances 4 -> 7 -> 10 -> 13 -> 16, so my "prefix ends at item 4"
  reading was wrong. The reasoning-item removal is real but does not explain cacheRead=3712 on
  its own; the 12928 hits after same-prefix side-calls point at admission/warming behaviour,
  which A3 must isolate from the replay mechanism.
- H1 reclassified: `parallel_tool_calls:false` is an unjustified default (no comment, converter
  and stream state already handle plural calls). The 26.8 s is an upper bound, not a saving.
  The event-ordering edge (second output_item.added before the first call's done,
  codex-oauth.ts:1483-1512) is the thing the paired experiment must watch.
- H2 narrowed: the 61.8 s turn is generation at ~55 tok/s, not silent reasoning; the 69.6 s
  before the final turn's first summary text is the cleaner reasoning-interval evidence.
- H3 lowered: no code evidence of local buffering; the codex-exec comparison is confounded
  unless backend and serialized fields match.
- H5: waste, not critical path, until account-level contention is measured.
- A0 first, A1 as the first experiment, A7 rejected for now.

Rejected nothing. What would change my mind on the ordering: if A1 shows Read turns still
at ten with the flag on, H1 drops and A2 (effort A/B) moves to first.

Executing now, without touching the live proxy: A0 (ttftMs/totalMs on the `stream done` line)
and A1 (`parallel_tool_calls` behind CCX_PARALLEL_TOOL_CALLS=1) on two isolated gateway
instances (ports 17881 flag-on, 17882 flag-off) driven by headless `claude -p` with the identical
task, concurrently. Results carried into the round-2 brief.


---

## Round 2 — orchestrator

Round 2 brief. The paired experiment you asked for ran (A0 + A1), on two isolated gateway
instances built from the patched source (CCX_PARALLEL_TOOL_CALLS gate; ttftMs/totalMs on the
stream done line), driven by headless `claude -p` with the identical task, concurrently, both
on codex-oauth:gpt-5.6-luna@max. No live-proxy change. Logs: gw-on.log / gw-off.log in the
job tmp dir; the numbers below are copied from them.

FLAG OFF (baseline): duration_ms=169780 num_turns=12 correct. Per-request totalMs:
3158,2905,3224,3373,2831,5261,4199,4274,5829,4919,48263(out=2644),51844(out=2807).
cacheRead per request: 3712,18048,31360,31360,31360,31360,18048,3712,31360,26240,49792,49792.

FLAG ON: duration_ms=224126 num_turns=22 correct=True. Per-request: totalMs=3483 toolCalls=1 output=149 cacheRead=3328 ;totalMs=7892 toolCalls=9 output=330 cacheRead=3328 ;totalMs=25105 toolCalls=1 output=1325 cacheRead=30976 ;totalMs=20107 toolCalls=9 output=1071 cacheRead=19712 ;totalMs=75500 toolCalls=1 output=4163 cacheRead=30976 ;totalMs=71431 toolCalls=0 output=3917 cacheRead=17664 ;
Two turns carried toolCalls=9 (nine Reads in one turn). errors=0; no block-ordering fault
observed in the log; the answer was correct.

Facts this establishes:
F1 parallel_tool_calls works end to end through the converter and stream handler.
F2 Generation throughput is ~54-55 tok/s on both arms and on both client paths (Agent tool and
   headless) - so it is the ChatGPT backend's rate for this model/tier, not the pipeline.
F3 cacheRead GROWS with depth on the headless path (to 49792) - the work order's §8 criterion.
   On the Agent-tool subagent path it was pinned at 3712. The one structural difference seen:
   the subagent path interleaves Claude Code's "Describe your most recent action" side-calls
   (same prompt_cache_key, different last user message) between real turns.
F4 ttftMs as implemented measures time to response.created (30-57 ms); it must be moved to the
   first output/reasoning delta to mean anything.

Questions:
Q1 Given F2, how much of luna@max's gap is now attributable to the model at max effort versus
   fixable pipeline items? Recompute the ranking with numbers.
Q2 F3: propose the mechanism by which the side-calls pin cacheRead at 3712, and the minimal
   experiment that falsifies it (e.g. headless run with a synthetic interleaved side-call).
Q3 Should parallel_tool_calls default to true now? State the residual risk and what one more
   check would retire it.
Q4 Revise plan.md §5 (actions) into the final ordered list. Mark APPLY / REJECT / EXPERIMENT.

## Round 2 — agent-partner

The strongest correction is that A0 did not instrument request TTFT or full request time. `fetchCodexWithRetry(...)` completes before `pumpResponsesStream(...)` is called (adapters/providers/codex-oauth.ts:1138-1157), while `makeState()` initializes `startedAt` inside that pump (adapters/providers/codex-oauth.ts:1337). Therefore `ttftMs=30–57` is headers-to-`response.created`, and `totalMs` is SSE-body duration after headers. Authentication, conversion, upload, upstream queue/prefill before headers, and tool execution are absent. The source comment claiming `startedAt` is just before fetch is wrong.

Q1: the original gap is 156.9 s. Of that, 125.7 s (80.1%) lies in the two long-generation phases: Luna took 169.2 s versus Opus’s 43.5 s. Another 26.8 s (17.1%) lies in the Read phase, although that remains a cross-model upper bound rather than pipeline attribution; 4.4 s (2.8%) is elsewhere. Luna’s 9,230 output tokens imply about 167.8 s at 55 tok/s, nearly its entire 169.2 s in the long phases. Thus roughly 80% of the observed gap is model/effort/output behavior, but F2 cannot separate model identity from `max` effort—that still requires A2.

The new A/B reinforces this while rejecting parallelism as a demonstrated optimization. OFF SSE times sum to 140.080 s; ON sums to 203.518 s. ON increased stream time by 63.438 s and wall time by 54.346 s (32%). Its final two responses alone added 46.824 s and 2,629 tokens, which is about 48 s at 54–55 tok/s. Batching may have saved 9.092 s outside the measured SSE intervals (`wall − ΣtotalMs`: 29.700 s OFF versus 20.608 s ON), but that bucket mixes tool execution, client overhead, and the omitted pre-header interval.

Revised ranking for recoverable wall time: H2 > H4 > H5 > H1 > H3 > H6. H2 contains the measured 125.7 s phase gap. H4 is unquantified because the timer misses first material delta, but it can affect every deep turn. H5 wasted roughly 106 s of upstream generation for the measured 5,846-token orphan, while proven critical-path saving remains zero. H1’s only measured wall effect is −54.346 s recovery—a regression—despite a possible 9.092 s saving outside SSE. H3 contributes approximately none of the 54–55 tok/s generation rate, although preprocessing and pre-header latency remain unmeasured. H6 directly recovers zero.

Q2: the plausible side-call mechanism is same-key cache-line displacement combined with late completion. A disconnected side-call continues upstream, may represent an older branch, and can finish after a newer main request; if `prompt_cache_key` selects a limited latest admitted candidate, that late completion could replace the useful main-line candidate. But “same transcript, different final user message” alone cannot explain a fall to 3,712: such requests still share a deep prefix. Fixed-base reuse additionally requires an earlier serialized divergence, a whole-candidate admission policy, or concurrency behavior not yet observed. The cross-client correlation is therefore not causal evidence.

The minimal falsifier is a controlled raw-request sequence with separate unique cache keys for control and treatment. Grow identical append-only main requests beyond 13k tokens. Between treatment requests, inject the exact observed side-call body under the treatment key, including its timing/disconnect behavior; do not inject it for control. If two subsequent treatment main requests continue growing beyond 13k comparably to control, side-calls are not sufficient to pin reuse. If they collapse, repeat with the side-call on a distinct key; recovery there isolates same-key interference.

Q3: `parallel_tool_calls` should remain opt-in. F1 proves one successful upstream ordering, not every legal ordering, and the only latency sample regressed. The handler still permits `start(call1), start(call2), delta(call1), stop(call1)`, because it emits each block immediately at `response.output_item.added` and closes it only at `response.output_item.done` (adapters/providers/codex-oauth.ts:1492-1569). An adversarial stream fixture with two calls, interleaved argument deltas, and reverse completion must assert contiguous Anthropic block lifecycles. Passing that after buffering/serialization retires the protocol risk; repeated paired workloads are separately required before changing the performance default.

The previous staged plan was accepted in full, so there is no rejected prior proposal to reopen.

**Disagreements**

- A0’s `totalMs` is not full request latency: state is initialized only after `fetchCodexWithRetry` returns, so all pre-header latency is omitted.
- F1 does not justify default-on parallel calls; the only paired sample was 54.346 s slower and did not exercise adversarial interleaving.
- F2 attributes the generation rate to the backend but cannot separate Luna model behavior from max effort; only a matched effort A/B can do that.
- Interleaved side-calls are correlated with shallow cache reuse, but a different final user suffix alone cannot logically reduce a deep common prefix to 3,712 tokens.
- The old reasoning-cache-disabled experiment is no longer the minimal cache test because headless cache reuse already grows with reasoning replay enabled; the side-call must now be isolated directly.

**Wants another round:** yes — I hold a BOUNDED FALSIFIABLE PROPOSAL for the next round: carry a completed alternating luna@max versus luna@medium A/B with parallelism fixed OFF and corrected fetch-start-to-first-material-delta timing. It will quantify how much of the dominant 125.7-second phase gap is specifically effort-sensitive while testing answer quality.

## Round 2 — orchestrator's ruling

Ruling, round 2 (orchestrator). APPLIED the staged plan in full.

Accepted: A0's totalMs starts after fetchCodexWithRetry returns headers, so it omits pre-header
latency and ttftMs measures response.created - both must be moved to fetch-start and to the
first material delta. F1 does not justify default-on: the one paired sample was 54 s SLOWER
(224.1 s vs 169.8 s; nine-call turns were followed by four heavy reasoning turns instead of
two) and did not exercise adversarial interleaving. CCX_PARALLEL_TOOL_CALLS stays default-off.
F2 (55 tok/s on both client paths) attributes throughput to the backend but cannot separate
the model from max effort. F3: side-calls correlate with the pinned 3712 but a differing final
suffix cannot by itself shrink a deep common prefix; isolate the side-call directly.

Next round (not run in this session; context budget exhausted): alternating luna@max vs
luna@medium A/B, parallelism OFF, corrected timing, judged on answer quality as well as time.
The two isolated gateways and the headless-claude harness in the job tmp dir are the rig.
