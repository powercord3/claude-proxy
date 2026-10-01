# Discussion — Codex prompt-cache: cch normalization, conversationKey collision, and any other cache fixes

Opened 2026-09-05T22:51:49Z. Cap: 4 rounds.
Members, in speaking order: agent-partner.

Extend past the cap only on new evidence, a concrete counterexample, or a bounded
falsifiable proposal that the NEXT round would carry — never because disagreement
remains.


---

## Round 1 — orchestrator

# Round 1 brief

Read `plan.md` in this room directory. It carries reproduced measurements, not arguments --
please attack the plan, not the problem statement, unless you think a measurement is
misinterpreted.

The repository is the claude-proxy source. The relevant files are
`adapters/providers/codex-oauth.ts` (see `toResponsesInput`, `flattenSystem`,
`chatCodexOAuthInner` request assembly, and the two diagnostic probes near the end of
`chatCodexOAuthInner`) and `adapters/codex-reasoning-cache.ts`.

Cite file:line for every claim about the code. I will check them.

## What I most want argued

**1. Weak point A5 is the one I am least sure of, and it may invalidate fix A.**
`systemChars` flips between 7978 and 9410 within a single conversation. `cch=` is fixed-width,
so it does not explain a 1432-char swing. If a second, larger thing is being added to and
removed from `instructions` mid-conversation, then normalizing `cch` alone buys nothing and I
will have shipped a system-prompt rewrite for no gain. Read `flattenSystem` and the gateway that
feeds it (`adapters/anthropic-gateway.ts`) and tell me what could produce a two-valued
`instructions` length within one conversation. If you cannot identify it from the code, say so
and tell me what to instrument -- I have both probes live and can re-run.

**2. Should fix A normalize `cch` narrowly, or the whole metadata preamble line?**
Narrow is safer but leaves other varying fields; broad risks discarding something load-bearing.
Give me a rule for deciding, not just a preference.

**3. Fix B, weak point 1 is unverified and load-bearing.**
If the first user message is not stable across turns after stripping system-reminders, fix B
fails. Can you determine from the code whether Claude Code mutates the first user message
between turns? If not, what is the cheapest instrument that would settle it?

**4. Fix B, weak point 5: should the reasoning cache and `prompt_cache_key` share a key at all?**
I lean toward splitting them because their requirements differ. Argue me out of it or sharpen it.

**5. Anything in "Other candidates" that deserves promotion**, especially whether
`effectiveReasoningEffort` flipping mid-conversation is a real invalidation source in practice
or a theoretical one.

## What would change my mind on fix A

If you can show `cch` is read back by anything, or that the 9410/7978 swing is the dominant
invalidation source and `cch` is noise on top of it, I will drop the `cch` rewrite and go after
the swing instead. Concretely: if the swing happens on ~22% of requests (14 of 63 observed) and
`cch` changes on 100%, `cch` is still the binding constraint -- unless the swing is what
actually moves `cacheRead`. Tell me if that reasoning is wrong.

## Constraints

- Members are read-only. Propose a full revised `plan.md`; do not edit files.
- I care about correctness over cleverness. The reasoning-cache cross-contamination (fix B,
  consequence 2) is a correctness bug and I want it fixed even if it buys zero latency.
- Do not propose removing the diagnostic probes; they are how the next measurement happens.


---

## Round 1 — orchestrator

# Round 1 brief

Read `plan.md` in this room directory. It carries reproduced measurements, not arguments --
please attack the plan, not the problem statement, unless you think a measurement is
misinterpreted.

The repository is the claude-proxy source. The relevant files are
`adapters/providers/codex-oauth.ts` (see `toResponsesInput`, `flattenSystem`,
`chatCodexOAuthInner` request assembly, and the two diagnostic probes near the end of
`chatCodexOAuthInner`) and `adapters/codex-reasoning-cache.ts`.

Cite file:line for every claim about the code. I will check them.

## What I most want argued

**1. Weak point A5 is the one I am least sure of, and it may invalidate fix A.**
`systemChars` flips between 7978 and 9410 within a single conversation. `cch=` is fixed-width,
so it does not explain a 1432-char swing. If a second, larger thing is being added to and
removed from `instructions` mid-conversation, then normalizing `cch` alone buys nothing and I
will have shipped a system-prompt rewrite for no gain. Read `flattenSystem` and the gateway that
feeds it (`adapters/anthropic-gateway.ts`) and tell me what could produce a two-valued
`instructions` length within one conversation. If you cannot identify it from the code, say so
and tell me what to instrument -- I have both probes live and can re-run.

**2. Should fix A normalize `cch` narrowly, or the whole metadata preamble line?**
Narrow is safer but leaves other varying fields; broad risks discarding something load-bearing.
Give me a rule for deciding, not just a preference.

**3. Fix B, weak point 1 is unverified and load-bearing.**
If the first user message is not stable across turns after stripping system-reminders, fix B
fails. Can you determine from the code whether Claude Code mutates the first user message
between turns? If not, what is the cheapest instrument that would settle it?

**4. Fix B, weak point 5: should the reasoning cache and `prompt_cache_key` share a key at all?**
I lean toward splitting them because their requirements differ. Argue me out of it or sharpen it.

**5. Anything in "Other candidates" that deserves promotion**, especially whether
`effectiveReasoningEffort` flipping mid-conversation is a real invalidation source in practice
or a theoretical one.

## What would change my mind on fix A

If you can show `cch` is read back by anything, or that the 9410/7978 swing is the dominant
invalidation source and `cch` is noise on top of it, I will drop the `cch` rewrite and go after
the swing instead. Concretely: if the swing happens on ~22% of requests (14 of 63 observed) and
`cch` changes on 100%, `cch` is still the binding constraint -- unless the swing is what
actually moves `cacheRead`. Tell me if that reasoning is wrong.

## Constraints

- Members are read-only. Propose a full revised `plan.md`; do not edit files.
- I care about correctness over cleverness. The reasoning-cache cross-contamination (fix B,
  consequence 2) is a correctness bug and I want it fixed even if it buys zero latency.
- Do not propose removing the diagnostic probes; they are how the next measurement happens.

## Round 1 — agent-partner

The strongest weakness is earlier than A5: fix A is not causally established. A changing `cch` at character 85 supposedly prevents reuse after that point, yet requests still report 3,712/5,760 cached tokens. That is a concrete counterexample to the plan’s simple “serialized exact prefix” model unless those tokens are an upstream-internal prefix. Object construction order (`instructions`, then `input`, then `tools`) at `adapters/providers/codex-oauth.ts:664-675` does not prove the upstream cache’s internal token ordering. Run the narrow rewrite as a controlled canary before making it default.

A5 is identifiable only to source category, not content. `flattenSystem` merely concatenates nonempty system blocks with one newline (`adapters/providers/codex-oauth.ts:194-200`). The gateway always invokes native-search substitution on the Codex lane (`adapters/anthropic-gateway.ts:426-432`), and substitution always appends the same `searchNote`, even when no web tool was removed (`adapters/web-search-substitution.ts:15-33`). Therefore that proxy mutation cannot toggle by request. The 1,432-character swing must arrive in the inbound `body.system`: either block membership changes or an existing block’s text changes. If exactly one nonempty block toggles, its text should be 1,431 characters because `flattenSystem` contributes the separator newline.

The current shell probe cannot reveal that later difference: it stops at the first differing character, which is always `cch` (`adapters/providers/codex-oauth.ts:758-763`). Add per-block length/hash signatures and a second comparison after normalizing only `cch`. Instrument before `applyNativeSearchSubstitution`, then correlate normalized-system state transitions—not merely state prevalence—with `cacheRead`. Fourteen large requests out of 63 is not a 22% invalidation rate; invalidations depend on transitions, and a recurring previously cached state may hit again.

Normalize narrowly, not the whole preamble. The rule should be: normalize only a field observed to vary within one logical run, whose grammar is recognized exactly, whose value is not consumed by repository code, and whose isolated rewrite measurably raises cache reuse without behavior changes. Stable fields such as version, entrypoint, subagent status, and `cc_prompt_id` fail the first criterion. For `cch`, match one exact five-hex field in the recognized metadata line; warn once on zero or multiple matches. I found no proxy readback path: the system value is flattened (`adapters/providers/codex-oauth.ts:194-200`) and placed directly into the upstream request (`adapters/providers/codex-oauth.ts:659-675`). That does not prove Claude Code itself regards the field as inert, because its source is absent here. Use an opt-in canary first, then default-on with a preservation escape hatch only after measurement.

The proxy cannot establish whether Claude Code mutates its first user message. Inside this repository, message normalization only reorders trailing developer messages and retains the original message objects (`adapters/providers/codex-oauth.ts:289-299`); the gateway mutation targets tools and system, not messages (`adapters/anthropic-gateway.ts:426-432`). The cheapest settling instrument is to log raw-first-user hash, reminder-stripped hash, remainder length, and `cc_prompt_id` for one isolated multi-turn run. The existing probe is unsafe for this purpose because it indexes prior state by the already-colliding `promptCacheKey` (`adapters/providers/codex-oauth.ts:756-779`).

I agree with splitting the keys, but would sharpen it: stripping reminders is adequate only for prompt-cache affinity, not strict reasoning isolation. Identical fan-out prompts remain a known collision. The reasoning cache should instead be keyed by the immediately preceding assistant tool-call identity. Inbound `tool_use.id` becomes the Responses `call_id` (`adapters/providers/codex-oauth.ts:345-351`), while the upstream call ID is forwarded unchanged to Claude Code (`adapters/providers/codex-oauth.ts:1075-1096`). That gives a natural per-turn rendezvous: retain IDs emitted in a response, store that response’s reasoning under the ID tuple, and retrieve it when the same tuple appears in the next request. Requests without such an ID should skip reasoning reuse rather than risk cross-contamination. This also fixes stale reuse: today `finalize` updates the cache only when new reasoning is nonempty (`adapters/providers/codex-oauth.ts:985-995`), while `setReasoningItems` otherwise performs a full replacement (`adapters/codex-reasoning-cache.ts:130-140`).

`effectiveReasoningEffort` is a real request change, not merely theoretical: compaction caps efforts above medium (`adapters/providers/codex-oauth.ts:417-424`), and the changed value is sent in `reasoning.effort` (`adapters/providers/codex-oauth.ts:663-675`). Current OpenAI guidance explicitly says to keep request-level effort unchanged to preserve prompt caching ([official model guidance](https://developers.openai.com/api/docs/guides/latest-model)). Its practical frequency and cost remain unmeasured, so promote its instrumentation, not an immediate behavior change. Also inspect or request the official `prompt_cache_diagnostics` exposed for current Responses models before inferring miss causes solely from `cached_tokens` ([official Responses reference](https://developers.openai.com/api/reference/cli/resources/responses/methods/create)).

**Disagreements**

- Fix A is not yet a fix; early `cch` divergence coexisting with 3,712/5,760 cached tokens contradicts the plan’s unverified serialized-prefix model and requires an intervention test.
- The 14-of-63 large-system count is state prevalence, not an invalidation rate; transitions and cache reuse must be correlated.
- The current first-difference shell probe cannot identify the 1,432-character toggle because changing `cch` always masks later differences.
- Whole-preamble normalization is unjustified; stable metadata fields have neither been measured as invalidators nor shown inert.
- A reminder-stripped first-user hash cannot be the reasoning isolation key because identical fan-out prompts still collide.
- Skipping `setReasoningItems` on an empty result is already a correctness risk and should be fixed with the reasoning-key redesign, not left under Other candidates.
- The existing probe’s use of the globally colliding `prompt_cache_key` means cross-request comparisons may be cross-conversation and should not be treated as per-conversation evidence without an isolated run.

**Wants another round:** yes — BOUNDED FALSIFIABLE PROPOSAL: the next round should carry one isolated trace containing per-system-block signatures, raw versus `cch`-normalized hashes, stripped-first-user hashes, state-transition counts, and corresponding `cacheRead`; that single trace can decide both A5 and whether fix A deserves promotion beyond an opt-in canary.

## Round 1 — orchestrator's ruling

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
