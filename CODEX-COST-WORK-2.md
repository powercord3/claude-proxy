# Codex cost work order #2 — state of the world, and the exec-vs-SDK A/B

Written 2026-09-06. Supersedes nothing: `PROMPT-CACHE-WORK.md` (2026-09-05) is still the
history and its §2 measured problem still reads correctly. This file records what changed on
2026-09-06, closes several of its open threads with evidence, and specifies the one experiment
that is still worth running.

Read §1 before touching anything. §5 is the do-not-re-derive list.

---

## 1. State of the world, 2026-09-06

### 1.1 What is live right now

The proxy on 127.0.0.1:17870 is running with `CCX_NORMALIZE_CCH=1` set **ad hoc in its process
environment**. No launcher sets it — not `~/.claude-proxy/start-proxy.cmd`, not anything under
`bin/`, not the shell. Verified by reading both and by `env`.

**This means the good behaviour is the fragile state.** Any ordinary restart reverts it.

Also live and default-on, from the 2026-09-06 exp3 work (`.room-luna-latency/measurement-r4-cachefix.md`):
`conversation_id` + `session_id` headers set to `prompt_cache_key`, mirroring what Codex CLI
sends (`codex-rs/core/src/client.rs`). Opt-out `CCX_CODEX_SESSION_HEADERS=0`.

### 1.2 What is staged on disk and NOT yet live

`CCX_NORMALIZE_CCH` promoted to **default-on** in code, mirroring the `isPromptCacheKeyV2Enabled`
pattern: undefined → enabled; `"0"`/`"false"`/`"off"` (case-insensitive) → disabled.

- `adapters/providers/codex-oauth.ts` — new exported `isCchNormalizeEnabled()`; gate in
  `cchNormalizedForWire` flipped. Backup: `codex-oauth.ts.bak-cchdefault-20260906`.
- `tests/codex-oauth.test.ts` — unit tests for the new predicate.
- `tests/prompt-cache.test.ts` — two assertions that encoded the OLD default flipped, and their
  names corrected. Backup: `prompt-cache.test.ts.bak-cchdefault-20260906`.

`npx vitest run` → **150/150 passing**. `npx tsc -p tsconfig.json --noEmit` → **clean, exit 0**.
Both verified independently of the agent that made the change. **Nothing committed.**

**Pending action: one restart of 17870 to make this live.** Until then we are one restart away
from silently losing the single biggest cache win measured to date.

### 1.3 The measured picture

Matched A/B, identical 36-file sequential-read brief on both lanes. This closes
`PROMPT-CACHE-WORK.md` §9's second open thread, which had never been established.

| | codex luna@max | claude sonnet |
|---|---|---|
| turns completed | 27 (died at 28, transient) | 37 |
| final context | 260k | 464k |
| **full-price input, total** | **2,979,861** | **74** |
| avg full-price input / turn | ~110,365 | 2 |
| cache reads | 1,243,008 | 11,462,627 |
| cache creation | n/a | 437,598 |
| wall clock | ~110 s | 194 s |

**Latency is no longer quadratic.** Per-request `totalMs` was flat across context growing
14k → 260k: first-half mean 3,559 ms, second-half mean 3,364 ms. TTFT stayed 1–20 ms even at
246k input. The quadratic problem today is **cost, not time** — a change from the §2 picture in
the previous work order, and the reason `luna@medium` vs `luna@max` s/tool-call figures there
should not be re-cited without re-measuring.

**Prefix stability is NOT the binding constraint.** Every shell field was constant across the
whole run: `systemChars=4691`, `normInstrHash=9f4741`, `toolsHash=06e06a`, `effort=max`. At turn
27 `prefix-probe` reported **84 of 89 input items byte-identical**, 94.8% of prompt bytes stable
— and only 5.4% was credited as cached. A stable prefix that is not credited means the prompt is
not the variable.

**The binding constraint is replica routing.** Established by the exp3 control: a byte-identical
request replayed sequentially on one `prompt_cache_key` returned
`3712, 44672, 5760, 44672, 5760, 44672` — 7 hits / 12. Same bytes, different answer.

**The residual miss is far more expensive than its rate suggests.** The session-header fix cut
misses to ~1 in 10–20 requests (I measured 1 in 27, consistent). But the cached prefix grows
*geometrically* — 3712 → 13952 → 76416 → 142976 took 17 turns to climb — and a single miss resets
it to the preamble:

```
turns  1–17  full-price input:   773,002   peak cacheRead 142,976
turns 18–27  full-price input: 2,206,859   peak cacheRead  13,952  ← never recovered
```

**74% of the run's total cost landed after one miss**, because there were not enough turns left
to re-climb. Miss cost therefore scales with conversation depth — backwards from what you want.
No public report of this climb-then-collapse pattern exists (checked: private Discord archive
plus a Reddit/X/YouTube/HN/GitHub sweep), so treat it as a new characterisation.

`cacheRead` values are always multiples of 128 (3712, 13952, 76416, 142976 → ×128 of 29, 109,
597, 1117), consistent with 128-token-block prefix caching.

### 1.4 Why the Claude lane reaches ~100% and this one cannot

Different caching contracts, not different tuning:

| | Anthropic | ChatGPT Codex |
|---|---|---|
| cache is | **declared** — explicit `cache_control` breakpoints | **discovered** — opportunistic prefix match |
| write | explicit, billed (437,598 tokens in the control run) | cannot be forced |
| hit depends on | prefix + TTL | prefix + TTL + **replica routing** |

There is no client-controlled cache breakpoint on the Responses API. `prompt_cache_key` is the
only lever, and it buys affinity only in combination with the session headers.

---

## 2. Ruled out on 2026-09-06 — do not retry without new information

All probed against `https://chatgpt.com/backend-api/codex/responses` on the ChatGPT OAuth
subscription lane, with the exact header set `chatCodexOAuthInner` builds, and a control request
passing immediately before and after every sweep. Scripts:
`~/.claude/jobs/533daa3c/tmp/probe-store/probe{,2,3,3b,4,5}.ts`.

| attempt | result |
|---|---|
| `store: true` | 400 `{"detail":"Store must be set to false"}` |
| `previous_response_id` (with `store:false`) | 400 `{"detail":"Unsupported parameter: previous_response_id"}` |
| `conversation` | 400 `{"detail":"Unsupported parameter: conversation"}` |
| `context_management: [{"type":"compaction","compact_threshold":1000}]` | **200 ACCEPTED**, but no measured reduction in billed input |

**Server-side conversation state is unavailable on this endpoint.** The full-transcript re-upload
is structural. Only miss frequency and miss cost are controllable.

The `context_management` A/B was **confounded** and must not be cited as a negative on the
mechanism: the no-compaction call happened to get a 2,688-token tools-shell cache hit and the
compaction call got a complete miss, and 2,688 ≈ the whole 2,636-token delta. Comparing uncached
content only, the padding was billed in full both times. A cache-matched retest is the honest
way to settle it, and is listed in §4.

**Parameter sweep** (measured, one variable per call, control-bracketed):

- REJECTED, flat `Unsupported parameter`: `truncation`, `metadata`, `temperature`, `top_p`,
  `user`, `max_output_tokens`, `conversation`, `previous_response_id`.
- ACCEPTED: `text`, `parallel_tool_calls`, `service_tier`, `prompt_cache_key`, `store:false`,
  and the eight baseline fields.
- `context_management` — name recognised, distinct error class (schema validation, not
  "unsupported"): array of objects, min length 1, each needing a `type`. Only known-good value
  is `"compaction"`. Anthropic's `clear_tool_uses_20250919` is explicitly rejected.

The LiteLLM issue's proposed allowlist (BerriAI/litellm#21193) is **wrong for this backend** on
`previous_response_id` and `truncation`, and misleading on `store` (name accepted, value
constrained to `false`). Do not build a guard from it without re-measuring.

**Nothing the proxy sends by default is rejected** — all 13 fields measured ACCEPTED. An
allowlist guard is therefore defensive-only, not a live bug fix. It is still worth having: the
`prompt_cache_diagnostics` canary (`CCX_CACHE_DIAG_CANARY=1`) 400s and kills every codex request
while on, which is exactly the class of failure a guard contains.

**Fan-out contention: disproved.** Three concurrent agents with byte-identical prompts, sharing
one `prompt_cache_key` by design, measured *better* than solo on the same task:

| run | requests | mean hit | cum. uncached |
|---|---|---|---|
| solo baseline | 14 | ~29% | 153,736 |
| concurrent B | 11 | 66.8% | 84,068 |
| concurrent C | 7 | 65.8% | 70,888 |

The shared-key design is vindicated. No change needed.

**An isolated second proxy instance is not currently possible.** `CLAUDE_PROXY_PORT` exists
(`anthropic-gateway.ts:84`), but `pid-manager.js:13` hardcodes `~/.claude-proxy/proxy.pid`,
written on listen and `unlinkSync`'d by exit handlers — a second instance clobbers then *deletes*
the live proxy's lock. `openai-auth.ts:22` likewise hardcodes the OAuth token file and can
rewrite it on refresh, racing the live proxy. Minimal unblock, **not made**: key both off
`process.env.CCX_STATE_DIR`. Do **not** work around this by copying OAuth credentials into an
isolated `USERPROFILE` — refresh-token rotation would invalidate the live copy and break the lane.

---

## 3. The experiment worth running: `codex exec` vs Codex SDK

### 3.1 Why, and what is actually claimed

A Discord report says using the **Codex SDK** instead of **`codex exec`** avoids the quadratic
cost. A dedicated research pass (private Discord archive + Reddit/X/YouTube/TikTok/HN/GitHub
sweep) found **no corroboration and no mechanism** — while returning positives on adjacent
topics, so the sweep could have found something. Treat the claim as **unsubstantiated, not
refuted**.

**Prior worth writing down before measuring, so it cannot be retrofitted:** `codex exec` is
one-shot, so each invocation starts a new session with a fresh session id and gets no prefix
reuse across turns. The SDK holds a persistent thread with a stable session id. If that is the
mechanism, the SDK's advantage is **cache-affinity continuity, not server-side state** — and
this proxy already has it (stable first-user-hash `prompt_cache_key` + matching
`conversation_id`/`session_id` headers), which is why cache reads climb to 142,976 at all.

If that prior is right, the finding does not transfer and there is nothing to port. The result
that *would* matter is the other one: that the SDK reaches a **different backend or auth mode**
where `store:true` / `previous_response_id` work. §2 shows they do not work on the endpoint this
proxy uses, and that negative is scoped to exactly that endpoint.

### 3.2 Step 0 — establish the SDK exists and what it does (do this first)

Cheap, and it can kill the experiment before any tokens are spent. Determine:

1. Does a Codex SDK exist as a distributable (e.g. `@openai/codex-sdk` on npm)? Get the version.
2. What base URL and auth mode does it use? ChatGPT OAuth, or an API key against
   `api.openai.com`? **If it requires an API key, the comparison is not like-for-like** — the
   public Responses API is a different backend and is already known to support `store:true`.
   Say so and stop; a "win" there would be an artefact of changing backends, not of the SDK.
3. Does it expose a thread/conversation abstraction, and does it send `previous_response_id`?

Read its source or its published types. Do not infer from marketing copy.

**Kill criteria — abandon and report, do not proceed to §3.3:** the SDK does not exist as a usable
distributable; or it only works with an API key (different backend, comparison invalid); or
reading it shows it sends the identical stateless request shape this proxy already sends.

### 3.3 The A/B, if step 0 survives

**Hypothesis (H):** for an identical N-turn task, the SDK path bills materially less cumulative
full-price input than the `codex exec` path.

**Null (H0):** both re-upload the full transcript each turn; any difference is replica
cache-routing noise.

**The single most important design constraint.** Cache hits on this backend are replica-dependent
and *provably* noisy — byte-identical requests alternate hit/miss (§1.3). **One run of each proves
nothing.** Any A/B here must be **repeated and interleaved**: alternate A,B,A,B,… for at least
5 pairs, and report per-pair numbers plus the spread, never a single pair. A result inside the
observed 3712↔44672 swing is noise. This is the trap the `context_management` A/B fell into.

**Task.** Deterministic, identical for both, no model discretion: read N=20 named files in a
fixed order, exactly one tool call per turn, emit the line count. (Reuse the brief from this
session's runs; it produced clean monotone transcript growth.)

**Instrument.** Neither path goes through 17870, so `proxy.log` will not see them. Options, best
first:
1. The backend's own `usage` block per turn. **It carries more than we have been reading**:
   `input_tokens_details.{cached_tokens, cache_write_tokens}` and an `attribution` map giving
   per-request-field cache breakdown (e.g. `request_fields.tools: {cached_tokens, input_tokens}`).
   This is a real find from 2026-09-06 — `PROMPT-CACHE-WORK.md` §P0.5 concluded the backend
   exposed no cache diagnostics, on the strength of `prompt_cache_diagnostics` 400ing. It does
   expose them, natively, in `usage`. Capture this if either path surfaces it.
2. Route both through the mitm on 17871 (`HTTPS_PROXY`) and record request bodies + response
   usage. Confirm first that it does not disturb the live routing other sessions depend on.
3. The CLI's own JSON event stream, if it reports usage.

Whichever is used, **prove the instrument can produce a positive before trusting a null** — show
it reporting a known cache hit on a control.

**Metrics, per turn and cumulative:**
- `input_tokens` billed at full price (the headline)
- `cached_tokens`, and `cache_write_tokens` if present
- request body size, and whether the full transcript is present
- wall clock per turn

**Confounds to hold fixed:** same model and effort; same task; same account; interleaved in one
time window (cache TTL and replica assignment drift); no other codex traffic — this session's
concurrent-agent runs would contaminate it.

**Decision rule.** H is supported only if cumulative full-price input differs by **more than the
observed noise band across all pairs**, in a consistent direction. State the band from the data,
not from expectation.

### 3.4 If H is supported

Do not port anything yet. First answer: **is the win from a different backend/auth, or from
request construction?** Inspect the SDK's actual wire requests. If it is a different backend, the
decision is a policy one (API-key billing vs subscription) and belongs to the user, not to an
implementation task. If it is request construction, identify the exact differing field and test
that field alone against our endpoint — §2 already shows most state-carrying fields are refused.

---

## 4. Other open items, ranked

1. **Restart 17870** so the staged `cch` default-on takes effect. Highest value, blocked on user
   approval. Use the proven fallback in `PROMPT-CACHE-WORK.md` §1 — take the pid from the port,
   never from `proxy.pid`, and do stop/start/poll/fallback in one call. Note that the session
   driving the restart may itself route through the proxy.
2. **Read the richer `usage` telemetry** (`input_tokens_details`, `attribution`) in
   `codex-oauth.ts` and log it. It would attribute a miss to a specific request field instead of
   inferring from probes, and it makes every future measurement here cheaper. Low risk.
3. **Cache-matched retest of `context_management: compaction`** — accepted but unproven; the one
   A/B was confounded. Same interleaving discipline as §3.3.
4. **Allowlist guard** on the outbound Responses body, built from the §2 measured table, not from
   the LiteLLM issue. Defensive; would have contained the `prompt_cache_diagnostics` outage.
5. **`CCX_STATE_DIR`** for `pid-manager.js` and `openai-auth.ts`, so an isolated second instance
   becomes possible without credential copying. Unblocks all future rig work.
6. **Reasoning-splice A/B** (`CCX_DISABLE_REASONING_CACHE=1`, flag already exists, no code
   change). Lowest value: the splice accounts for ~5 of 89 items of churn and churn is not the
   constraint. Needs a restart to test.

## 5. Do not re-derive

- Latency is flat, not quadratic. Cost is the problem.
- Prefix stability is not the constraint; replica routing is.
- Server-side state is refused four ways on this endpoint.
- Fan-out on a shared `prompt_cache_key` does not degrade caching.
- Nothing the proxy sends by default is rejected.
- A single A/B pair on this backend measures noise.
