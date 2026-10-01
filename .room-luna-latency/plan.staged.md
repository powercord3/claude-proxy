# Plan: why luna@max is slower than opus@medium and what is fixable

## 1. Original measured comparison

| | luna@max | sonnet@high | opus@medium |
|---|---:|---:|---:|
| wall-clock | 209.9 s | 55.8 s | 53.0 s |
| tool calls | 11 | 10 | 11 |
| answer correct | yes (101 defs) | yes | yes |

The Luna–Opus gap is 156.9 s. The Read phase accounts for 26.8 s of its location, the two long-generation phases for 125.7 s, and the remaining phases for 4.4 s. These are phase differences, not yet causal attribution.

## 2. Round-2 measurements

### Parallel flag OFF

- Wall: 169.780 s; 12 turns; correct.
- SSE-body `totalMs` sum: 140.080 s.
- Last two responses: 100.107 s, 5,451 output tokens.
- `cacheRead` grows as high as 49,792.

### Parallel flag ON

- Wall: 224.126 s; 22 turns; correct.
- Six upstream responses; SSE-body `totalMs` sum: 203.518 s.
- Two responses carried nine tool calls; reported tool calls sum to 20.
- Last two responses: 146.931 s, 8,080 output tokens.
- No errors or observed block-ordering fault.

### Derived results

- ON regressed wall time by 54.346 s (32%) and SSE-body time by 63.438 s.
- Its last two responses added 46.824 s and 2,629 tokens; at 54–55 tok/s, those tokens explain approximately 48 s.
- `wall − ΣtotalMs` fell from 29.700 s to 20.608 s, a possible 9.092 s batching benefit in a bucket that also includes tools, client work, and omitted pre-header latency.
- Generation throughput is consistently about 54–55 tok/s. Local forwarding is not the cause of that rate.
- Current `ttftMs` and `totalMs` begin only after `fetchCodexWithRetry` returns headers, because stream state is created inside `pumpResponsesStream`. `ttftMs` is therefore headers-to-`response.created`, not request TTFT; `totalMs` is not full request latency.

## 3. Ranked findings

### H2 — model/max-effort output behavior: rank 1

**APPLY.** About 125.7 s, or 80.1% of the original Luna–Opus gap, lies in the two long-generation phases. Luna emitted 9,230 output tokens there, equivalent to about 167.8 s at 55 tok/s versus 169.2 s observed.

This attributes the dominant gap to combined model, effort, and output behavior. It does not isolate `max` effort from model identity. Only a matched max/medium experiment can do that.

### H4 — side-call/cache interference: rank 2

**EXPERIMENT.** Headless requests demonstrate that deep cache reuse is possible with the existing reasoning replay: `cacheRead` reaches 49,792. The subagent path’s 3,712 pattern therefore is path-specific, but interleaved side-calls are only a correlation.

A possible mechanism is same-key displacement: a disconnected, older-branch side-call finishes late and replaces the useful cache candidate. A changed final user suffix alone should retain a deep common prefix, so a fixed 3,712 result additionally requires an early serialized divergence, limited whole-candidate admission, or a concurrency rule.

### H5 — orphaned side-calls: rank 3

**APPLY.** The measured 5,846-token orphan consumed roughly 106 s of upstream generation at 55 tok/s. This is proven resource waste. Proven critical-path recovery remains zero until account-level contention is measured.

### H1 — parallel tool calls: rank 4

**REJECT as default; retain as opt-in experiment.** The flag works for the one observed event trace and produces multi-call turns, but the only paired sample regressed by 54.346 s. The upstream response behavior changed enough to overwhelm any reduction in round trips.

The stream handler remains unsafe for a legal interleaving in which call 2 starts before call 1 finishes. Independent maps preserve IDs but do not make Anthropic content blocks contiguous.

### H3 — local pipeline: rank 5

**APPLY narrowly.** The matching 54–55 tok/s rate across paths rules out local forwarding as the generation-rate bottleneck. It does not measure gateway preprocessing, request upload, fetch-to-headers, or first-material-delta latency.

### H6 — instrumentation: rank 6 for recovery, rank 1 as enabler

**APPLY.** Instrumentation recovers no wall time directly, but the existing A0 timer starts too late and cannot quantify cache/prefill latency.

## 4. Cache falsification model

Use controlled request bodies rather than relying on nondeterministic agent behavior:

1. Give control and treatment distinct cache keys so they cannot warm or displace one another.
2. Send identical append-only main-request sequences until the stable prefix exceeds 13k tokens.
3. Between treatment requests, reproduce the observed action-description side-call body, completion order, and downstream disconnect under the treatment key.
4. Record serialized shell/input hashes, fetch start, headers, first material delta, completion order, and `cacheRead`.
5. Two consecutive treatment main requests growing beyond 13k comparably to control falsify side-calls as sufficient cause.
6. If treatment collapses, repeat with the side-call assigned a distinct key. Recovery isolates same-key interference; continued collapse implicates another structural or concurrency difference.

The old reasoning-cache-disabled experiment is no longer the first cache test: headless reuse already grows while reasoning replay is enabled, and disabling replay does not isolate the newly implicated side-calls.

## 5. Actions in final execution order

### A0. Finish timing instrumentation

**APPLY first.** Move request start before authentication/conversion and before `fetchCodexWithRetry`. Record monotonic boundaries for gateway receipt, adapter entry, auth complete, conversion/probes complete, fetch start, response headers, `response.created`, first reasoning delta, first text delta, first tool-call event, first downstream material write, completion, and client close.

Rename the present metric to `createdAfterHeadersMs`; define TTFT as fetch-start to first material reasoning/text/tool delta. Preserve both fetch-to-headers and SSE-body duration.

### A1. Matched effort A/B

**EXPERIMENT second.** With parallel calls OFF and completed A0 metrics, alternate at least three matched runs each of luna@max and luna@medium. Record output tokens, fetch-to-headers, first material delta, generation duration, wall time, tool behavior, correctness, and answer completeness.

A medium result is a usable latency improvement only if quality remains acceptable. This experiment separates max effort from model identity and directly tests the dominant 125.7 s opportunity.

### A2. Synthetic side-call/cache experiment

**EXPERIMENT third.** Execute the controlled sequence in §4. Start with the exact observed same-key side-call and disconnect pattern. Do not infer poisoning merely from different cache behavior across client paths.

**REJECT** the former reasoning-cache-disabled run as the next experiment because it does not isolate side-calls and headless cache growth already shows replay is not universally pinning reuse.

### A3. Parallel-stream hardening

**APPLY tests; REJECT default-on.** Add:

1. A conversion test with multiple calls and matching results.
2. An adversarial stream fixture: two `output_item.added` events, interleaved argument deltas, and reverse `output_item.done` order.
3. An assertion that each emitted Anthropic block has one contiguous start/delta/stop lifecycle.

Buffer or serialize tool blocks if the current handler fails. Keep `CCX_PARALLEL_TOOL_CALLS` opt-in. After correctness is hardened, run three alternating workload pairs and inspect why ON produced 20 reported calls and larger intermediate generations. Change the default only on repeatable net improvement without semantic duplication or answer regression.

### A4. Client-abort propagation

**APPLY.** Connect premature downstream close to an `AbortController` passed to the upstream fetch. Distinguish normal response completion and test disconnect before headers, during reasoning, during text, and after completion. This stops proven orphaned work; any critical-path benefit remains measured separately.

### A5. Side-call routing

**EXPERIMENT.** After A2 establishes whether side-calls affect caching and A4 makes cancellation reliable, classify the action-description request using its complete structural signature and exact generated prompt. A/B routing it to `housekeeping`; verify short-answer correctness, cache behavior, and main-turn latency. Reject substring-only routing.

### A6. Secondary one-variable experiments

**EXPERIMENT only after A0/A1/A2.** Test separately:

- `reasoning.summary:auto` versus `none`;
- configured verbosity versus `low`, only if verbosity is active;
- standard versus priority tier with credit/cost reporting;
- mitm versus direct gateway only if A0 finds meaningful pre-adapter or downstream delay;
- direct ChatGPT OAuth request versus proxy only with identical serialized input and fields.

**REJECT** changing `store:false` alone: the adapter still uploads full `input`, and retention semantics would change.

### A7. Default-agent policy

**REJECT for now.** Do not demote luna@max or promote parallel calls from single-run data. Reconsider the agent default after the matched effort A/B quantifies latency and quality.

## 6. Decision boundaries

- The measured 54–55 tok/s is backend generation behavior, not proof that all pre-generation latency is model-owned.
- Current per-response timers exclude fetch-to-headers; they cannot price cache/prefill improvements.
- Parallel calls are end-to-end compatible for one observed event ordering, not all legal orderings.
- The first parallel sample is a 54.346 s regression, despite a possible 9.092 s reduction outside SSE streaming.
- Side-calls are correlated with shallow reuse, but a different final suffix alone cannot explain a fixed 3,712-token boundary.
- Orphan resource waste is proven; account-level critical-path contention is not.
- The exact share due specifically to max effort remains unknown until A1.