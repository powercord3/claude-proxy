# Plan: restore upstream prompt caching on the Codex lane without cross-conversation reasoning reuse

## Established measurements

Over 10,228 historical requests with input >=20k tokens, aggregate cache reuse was 5.5%; median reuse was 6.7%; and 99.9% of requests read at most 8k cached tokens. `cacheRead` was usually 3,712 or 5,760 regardless of transcript depth.

Moving injected encrypted reasoning from `input[0]` to immediately before the last assistant turn made 80–90% of the `input` array byte-stable but did not change `cacheRead`. The placement is implemented at `adapters/providers/codex-oauth.ts:381-399`.

The observed instruction stream changes at `cch` on every sampled request and takes two lengths, 7,978 and 9,410. All observed traffic currently shares one `prompt_cache_key`; item counts falling from 58 to 26 prove that this key spans distinct conversations.

These measurements establish poor reuse and key collision. They do not yet establish that rewriting `cch` will improve reuse, because nonzero cached-token counts coexist with the early instruction divergence.

## Phase 0: repair attribution before changing behavior

Keep both existing probes and add the following diagnostics.

1. Before gateway mutation, record the inbound system representation: string versus array, block count, and for every block its index, type, character length, and short hash. Extract and log `cc_prompt_id` and redact the actual `cch` value. The gateway calls system substitution at `adapters/anthropic-gateway.ts:426-432`; substitution appends its fixed note at `adapters/web-search-substitution.ts:15-33`.

2. In the Codex adapter, record both the raw instruction hash and a diagnostic-only `cch`-normalized instruction hash. Compare all changed block signatures, because the current probe reports only the first differing character (`adapters/providers/codex-oauth.ts:758-763`).

3. Do not index diagnostic history solely by `prompt_cache_key`. The existing probe does so at `adapters/providers/codex-oauth.ts:756-779`, while the measurement proves that key is shared globally. For the controlled run, use an isolated process/run and additionally report `cc_prompt_id` plus the earliest assistant tool-call ID when present.

4. Log, for the first user message, the raw hash and length and the hash and length after removing recognized `<system-reminder>...</system-reminder>` blocks. Do not log message contents. Run at least one ordinary follow-up after an agentic tool loop, because stability only across tool-result turns does not prove stability across new user turns.

5. Correlate each request’s raw instruction state, normalized instruction state, tools hash, model, effective effort, candidate prompt-cache key, cached-token count, and—when returned—upstream prompt-cache diagnostics. The official Responses schema exposes `prompt_cache_diagnostics` and GPT-5.6 prompt-cache options ([Responses reference](https://developers.openai.com/api/reference/cli/resources/responses/methods/create)); first canary whether the ChatGPT backend accepts or returns them before enabling any request-side option generally.

The 1,432-character toggle is classified when the per-block signatures show whether a 1,431-character block is inserted/removed or an existing block changes by 1,432 characters. `flattenSystem` joins nonempty block texts with one newline at `adapters/providers/codex-oauth.ts:194-200`.

## Fix A: controlled, narrow `cch` normalization

Do not normalize the whole metadata preamble.

Implement a dedicated normalizer that:

- operates only on the recognized Claude Code metadata line;
- replaces exactly one `cch=[0-9a-f]{5}` value with a fixed-width constant;
- leaves version, entrypoint, subagent status, `cc_prompt_id`, and all user-authored instruction text unchanged;
- logs once if the recognized line contains zero or multiple `cch` fields; and
- is initially enabled only by an explicit canary environment flag.

The decision rule for any additional metadata field is conjunctive: it must be observed varying within one logical run, have an exact recognized grammar, have no repository consumer, and produce a measured cache benefit in isolation. Do not generalize from `cch` to the whole line.

Run matched raw and normalized canaries. Promote normalization to default-on, with an environment variable that preserves the original field, only if:

- normalized instruction hashes remain stable except for the separately identified 1,432-character state;
- cache reuse rises on same-state transitions;
- cache diagnostics or cached-token growth attribute the gain to the rewrite; and
- tool choices, completion status, and error rate show no regression.

If reuse does not move, drop fix A rather than broadening the rewrite speculatively.

## Fix B1: independent prompt-cache affinity key

Split prompt-cache key generation from reasoning-cache identity. Currently one `convoKey` feeds both reasoning lookup and `threadIdFor` at `adapters/providers/codex-oauth.ts:648-655`, and `threadIdFor` stores the UUID-shaped ID in the reasoning-cache entry at `adapters/codex-reasoning-cache.ts:89-100`.

For `prompt_cache_key`, hash the complete first-user remainder after removing only recognized leading system-reminder blocks; do not truncate it to 4,096 characters. The current truncation occurs at `adapters/codex-reasoning-cache.ts:82-87`. Hashing the already-resident message is bounded by request size and avoids the measured common-prefix collision.

Gate this derivation on the Phase 0 stability measurement. If the stripped hash changes on ordinary tool-result turns, identify the changing range before choosing a replacement. Identical user prompts may deliberately share a prompt-cache affinity key: this field groups similar requests and is not the isolation boundary.

Test distinct prompts, the measured 20,124-byte common reminder, multiple reminder blocks, malformed/unclosed tags, an empty remainder, identical fan-out prompts, and a first user message represented as content blocks.

## Fix B2: strict per-turn reasoning identity

Do not use the first-user hash for encrypted reasoning.

Associate reasoning returned by a response with the tool-call ID tuple emitted by that same response. Upstream call IDs are forwarded as Anthropic `tool_use.id` values at `adapters/providers/codex-oauth.ts:1075-1096`; on the next request those IDs are converted back into Responses `call_id` values at `adapters/providers/codex-oauth.ts:345-351`. Retain the emitted ID tuple separately from `funcCallByItemId`, because completed calls are currently removed at `adapters/providers/codex-oauth.ts:1138-1147` and the remainder is cleared during finalization at `adapters/providers/codex-oauth.ts:985-993`.

On the next request, derive the reasoning lookup key from the last assistant turn’s tool-call ID tuple. Inject only a matching entry immediately before that assistant turn. If no stable tool-call ID is available, skip reasoning reuse for that transition; correctness takes priority over preserving every possible reasoning blob.

Store an explicit empty result or delete the per-turn entry when a response returns no reasoning. The current conditional write at `adapters/providers/codex-oauth.ts:994` leaves stale reasoning in place, while writes replace the entire item list at `adapters/codex-reasoning-cache.ts:130-140`.

Tests must cover two simultaneous conversations with identical first-user prompts but different call IDs, out-of-order completion, multiple call IDs, a text-only assistant response, no new reasoning, cache expiry, and a resumed transcript. No test may permit reasoning produced for one ID tuple to be returned for another.

## Secondary invalidation: reasoning effort

Treat effort changes as a real but probably infrequent invalidation mechanism. Compaction detection examines the last user request at `adapters/providers/codex-oauth.ts:209-224`; `effectiveReasoningEffort` lowers high-or-greater compaction turns to medium at `adapters/providers/codex-oauth.ts:417-424`; and that value is sent in the request at `adapters/providers/codex-oauth.ts:663-675`.

Record effort transitions and their cached-token/cache-diagnostic outcomes. Current OpenAI guidance says request-level effort changes can disturb prompt reuse ([official model guidance](https://developers.openai.com/api/docs/guides/latest-model)). Do not remove the compaction optimization until a matched measurement shows that the two surrounding cache misses cost more than medium-effort compaction saves.

## Deferred candidates

Keep `store:false` and do not adopt `previous_response_id` in this change. The adapter deliberately sends the full stateless request with `store:false` at `adapters/providers/codex-oauth.ts:663-675`; changing server-side state and retention is a separate correctness and privacy decision.

Do not remove either diagnostic probe.

## Sequencing

1. Add attribution diagnostics and run one isolated multi-turn trace.
2. Run the opt-in narrow `cch` canary against a matched raw trace.
3. Independently split prompt-cache affinity from strict reasoning identity and fix stale-empty handling.
4. Re-run the matched workload after each change separately, then with both enabled.
5. Evaluate effort transitions only after A and B no longer confound the measurement.

## Success criteria

Correctness is mandatory: no encrypted reasoning item can cross tool-call identity, including identical-prompt fan-out, and a response with no new reasoning cannot cause stale reasoning injection.

Performance succeeds when `cacheRead` grows with stable transcript depth instead of remaining at 3,712/5,760, median hit ratio for requests above 20k input tokens exceeds 50%, and diagnostics attribute the improvement to a specific intervention rather than correlation. Report state-transition counts, not only counts of requests in each state.
---

## Orchestrator ruling, round 1

Accepted essentially whole. The decisive catch: `cacheRead` of 3,712 tokens cannot coexist with
a strict `[instructions][tools][input]` cache prefix that diverges at instruction character 85 --
that model predicts ~20 cached tokens. The serialized-prefix premise behind fix A is therefore
unproven, and fix A is correctly demoted to an opt-in canary gated on Phase 0 attribution.
Verified three citations before applying: `:994` conditional `setReasoningItems`, `:345-351`
`call_id: block.id`, `:417-424` compaction lowering effort to medium. All exact.

Also accepted, and a correction to my own evidence: the existing prefix-probe indexes by
`prompt_cache_key`, which the same plan proves is globally shared. So the "84% of input bytes
stable turn-to-turn" figure may compare across conversations and must be re-measured under an
isolated run before it is cited again.

### Amendment 1 -- treat the OpenAI cache-diagnostics citations as unverified

The plan cites `prompt_cache_diagnostics` and GPT-5.6 prompt-cache request options from
developers.openai.com. The room member cannot fetch URLs, so this is a claim about a document,
not about the ChatGPT backend this proxy actually talks to. Phase 0 step 5 must canary whether
the backend accepts or returns these fields, and the trace must record the negative result
explicitly if it does not. Nothing in the plan may depend on their existence until then.

### Amendment 2 -- B2 loses reasoning reuse on text-only assistant turns; accepted deliberately

Keying reasoning identity to the last assistant turn's tool-call ID tuple means a text-only
assistant response carries no key, so reasoning reuse is skipped for that transition. This is a
real cost, accepted because correctness outranks reuse here: the current behaviour returns one
conversation's chain-of-thought to another. Phase 0 should count how often text-only assistant
turns occur mid-conversation so the size of the forfeit is known rather than assumed.

### Standing question for round 2

If Phase 0 shows `cch` normalization does not move `cacheRead`, fix A is dropped. What then
explains a `cacheRead` pinned at exactly two values (3,712 / 5,760) across 10,228 requests and
every transcript depth? Two constants that stable look like a fixed cached unit, not a prefix
that happens to end in the same place. Name the mechanism that would produce that signature.
