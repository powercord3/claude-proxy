# Codex prompt-cache work order

Written 2026-09-05 for a fresh session to execute. Self-contained: assume no prior context.

Background and the argued plan live in `.room-cache/` (`plan.md` is the ruled artifact,
`discussion.md` the full round-1 transcript). Read `.room-cache/plan.md` first — this file is
the executable form of it, not a replacement.

---

## 0. State of the tree before you start

The working tree was **already dirty** before this work began (this is a patched fork). Do not
assume every uncommitted change is related. The changes belonging to this effort are all in
two files:

**`adapters/providers/codex-oauth.ts`**
1. `toResponsesInput` — cached encrypted-reasoning items used to be pushed at `input[0]`; they
   are now spliced immediately before the last assistant turn's items via `lastAssistantStart`.
   **Keep this.** It is verified at the probe level but has never been adversarially reviewed —
   the review agent was killed mid-stream by a proxy restart.
2. Two diagnostic probes near the end of `chatCodexOAuthInner`: `prefix-probe` (input-item
   divergence) and `shell-probe` (instructions/tools divergence). **Keep both.** Phase 0
   extends them; it does not replace them.

**`tests/codex-oauth.test.ts`** — three tests around the splice. 82/82 pass; `tsc --noEmit`
clean. Run `npx vitest run` and `npx tsc -p tsconfig.json --noEmit` before and after your work.

Nothing has been committed. Nothing else has been changed.

---

## 1. Operating the proxy (read before restarting anything)

The VSCode Claude Code extension routes through this proxy, so restarting it interrupts the
session you are talking to the user through. The plain `claude` CLI does not.

**The documented primary restart path is currently broken.** `Start-Process` on
`start-proxy.cmd` does not bring the proxy back. Use the direct-node fallback, which is proven
to work (recovered in-call on 2026-09-05):

```powershell
$log = "$env:USERPROFILE\.claude-proxy\proxy.log.fallback"
$old = (Get-NetTCPConnection -LocalPort 17870 -State Listen).OwningProcess | Select-Object -First 1
Stop-Process -Id $old -Force; Start-Sleep -Milliseconds 800
$node = "$env:ProgramFiles\nodejs\node.exe"; $src = "$env:USERPROFILE\.claude-proxy-src"
Start-Process -FilePath $node `
  -ArgumentList "`"$src\node_modules\tsx\dist\cli.mjs`"","`"$src\adapters\anthropic-gateway.ts`"" `
  -WorkingDirectory $src -WindowStyle Hidden `
  -RedirectStandardOutput $log -RedirectStandardError "$log.err"
foreach ($i in 1..40) { Start-Sleep -Milliseconds 500
  $c = Get-NetTCPConnection -LocalPort 17870 -State Listen -ErrorAction SilentlyContinue
  if ($c) { "UP pid=$($c.OwningProcess | Select-Object -First 1) (was $old)"; break } }
```

Consequences to remember:
- Take the listener pid **from the port**, never from `~/.claude-proxy/proxy.pid` — that file
  was stale (said 3748 when the listener was 14980).
- Because of the redirect, logs go to **`~/.claude-proxy/proxy.log.fallback`**, not `proxy.log`.
  The redirect **truncates** on start, so copy the log out before restarting if you need it.
- `Move-Item` on the live log fails (locked by the running process). Copy after the stop, or
  read it before.
- Never restart while a subagent is mid-request; it dies with `CCX_STREAM_ABORTED`.

**Two separate codex credential files exist and they rotate against each other.**
`~/.codex/auth.json` (used by the `codex` CLI and the `/codex-room` skill) and
`~/.claude-proxy/codex-oauth.json` (used by the proxy). A refresh in one invalidates the
other's refresh token. If the room reports "refresh token was already used", the user must run
`codex login` interactively — you cannot clear that gate. Do **not** copy tokens between the
files: the schemas differ and you risk invalidating the proxy's copy, which breaks the lane
everything depends on.

---

## 2. The measured problem (do not re-derive)

Over 10,228 historical requests with input ≥20k tokens, parsed from `proxy.log`:

```
cacheRead percentiles: p50=3712  p75=5760  p90=5760  p99=6784  max=19072
hit ratio:             p50=6.7%  p90=16.0%
cacheRead <= 8k on 99.9% of requests
aggregate: 871.5M input tokens, 47.9M cache-read (5.5%)
```

`cacheRead` sits at 3712 or 5760 on 96% of requests **regardless of transcript depth**. With
`store: false` re-uploading the full history every turn, per-turn cost grows with turn index,
so wall clock is quadratic in tool calls. Spawn telemetry: `luna@medium` 9.6 s/tool-call vs
`luna@max` 29.9 s/tool-call. On public benchmarks gpt-5.6-luna at max is slightly *faster* than
Opus, so this gap is our overhead, not the model's.

**The central unexplained fact, and the thing Phase 0 exists to settle:** `instructions`
diverges at character 85 on 100% of requests (a per-request `cch=<5 hex>` stamp from Claude
Code), yet 3712 tokens still come back cached. A strict `[instructions][tools][input]` cache
prefix would predict ~20 cached tokens. **So the serialized-prefix model is wrong**, and with it
the rationale for fix A. Two values that stable across 10,228 requests and every depth look like
a fixed cached *unit*, not a prefix that coincidentally ends in the same place.

---

## 3. Phase 0 — repair attribution before changing behaviour

No behaviour changes in this phase. Diagnostics only. The current probes cannot answer the open
questions, for reasons that matter:

- `shell-probe` reports only the **first** differing character. `cch` changes on 100% of
  requests, so it masks every later difference. The unexplained 1,432-char `systemChars` swing
  (7978 ↔ 9410, seen 49 vs 14 times in one run) is invisible to it by construction.
- `prefix-probe` indexes by `prompt_cache_key`, which §4 proves is globally shared — so its
  comparisons may be **cross-conversation**. The previously reported "84% of input bytes stable
  turn-to-turn" figure is therefore contaminated and must be re-measured before being cited.

Implement:

**P0.1 — inbound system representation, before gateway mutation.** In
`adapters/anthropic-gateway.ts`, near the `applyNativeSearchSubstitution` call site, log whether
`body.system` is a string or array, the block count, and per block: index, type, char length,
short hash. Log `cc_prompt_id`; **redact the `cch` value itself** (log its presence and length,
not its content). Note `applyNativeSearchSubstitution` appends a fixed 445-char `searchNote` to
the *end* of system for codex — constant, so not the swing and not a prefix breaker.

**P0.2 — per-block signature comparison in the adapter.** Extend `shell-probe` to report *all*
changed block signatures rather than the first differing offset, and to record two hashes side
by side: the raw `instructions` hash and a diagnostic-only `cch`-normalized hash. This is what
classifies the 1,432-char swing: per-block signatures show whether a ~1,431-char block is
inserted/removed or an existing block changes size. `flattenSystem` joins non-empty block texts
with a single newline.

**P0.3 — stop keying diagnostics on `prompt_cache_key`.** Add `cc_prompt_id` and the earliest
assistant tool-call id (when present) to the probe key. Run the decisive trace as an **isolated
single-conversation run** with no concurrent agents.

**P0.4 — first-user-message stability.** Log, for the first user message: raw hash and length,
plus hash and length after removing recognized `<system-reminder>…</system-reminder>` blocks.
**Log hashes and lengths only, never contents.** This is what gates B1. Critically: the trace
must include **at least one ordinary follow-up user turn after a tool loop** — stability across
tool-result turns does not prove stability across new user turns.

**P0.5 — correlate and canary.** Per request, record: raw instruction state, normalized
instruction state, tools hash, model, effective effort, candidate cache key, `cacheRead`.
The round-1 member cited `prompt_cache_diagnostics` and GPT-5.6 prompt-cache request options
from developers.openai.com. **Treat that as unverified** — it is a claim about a document, not
about the ChatGPT backend this proxy talks to, and the member cannot fetch URLs. Canary whether
the backend accepts or returns those fields and **record the negative result explicitly** if it
does not. Nothing may depend on their existence until confirmed.

**P0.6 — count text-only assistant turns** mid-conversation. B2 forfeits reasoning reuse on
those, and the size of that forfeit should be measured, not assumed.

### The trace that ends Phase 0

One isolated multi-turn run (a single subagent, nothing else on the codex lane), long enough to
capture at least one `systemChars` transition and one ordinary follow-up user turn. It must
answer:

1. What is the 1,432-char swing? (insert/remove of a block, or a block changing size)
2. Does `cacheRead` correlate with the swing, with `cch`, with both, or with neither?
3. Is the reminder-stripped first-user hash stable across turns — including a new user turn?
4. Does the backend return any cache diagnostics?

---

## 4. Fix B1 — independent `prompt_cache_key`  *(gated on P0.4)*

**The bug, measured.** `conversationKey` (`adapters/codex-reasoning-cache.ts`, ~line 82-87)
hashes `userTextOf(firstUserMessage).slice(0, 4096)`. Claude Code prepends a `<system-reminder>`
containing the global CLAUDE.md — **20,124 bytes** — to the first user message, so the 4096-char
slice never reaches conversation-specific text. Every conversation on this host hashes to the
same key. Evidence: only one key (`c47569b7`) was ever observed, with consecutive item counts
`22 → 58 → 26`. A conversation's input array only grows, so 58 → 26 proves distinct
conversations collide.

**Implement.** Split key generation in two — this key is for *affinity only*, not isolation.
For `prompt_cache_key`, hash the complete first-user remainder after removing recognized leading
`<system-reminder>` blocks, with **no 4096 truncation** (the message is already bounded by
request size). Currently one `convoKey` feeds both the reasoning lookup and `threadIdFor`; those
must become independent.

**Gate.** If P0.4 shows the stripped hash changes on ordinary turns, stop and identify the
changing range before choosing a replacement. Do not ship a key that churns.

Identical fan-out prompts sharing this key is **acceptable and arguably correct** — affinity is
the point. Isolation is B2's job.

**Tests:** distinct prompts; the 20,124-byte common reminder; multiple reminder blocks;
malformed/unclosed tags; empty remainder; identical fan-out prompts; first user message given as
content blocks rather than a string.

---

## 5. Fix B2 — strict per-turn reasoning identity  *(not gated; correctness)*

**The bug.** Because all conversations share one key, they share one reasoning-cache slot:
agents inject each other's encrypted chain-of-thought, last-writer-wins. This is a correctness
defect and is worth fixing **even if it buys zero latency**.

Note this is strictly better than the obvious fix of "hash the real prompt" — that still
collides for a fan-out of N identically-prompted agents.

**Implement.** Do not use any first-user hash for reasoning identity. Key reasoning to the
**tool-call ID tuple emitted by the response that produced it**:

- Upstream call ids are forwarded as Anthropic `tool_use.id`; on the next request those become
  Responses `call_id` values in `toResponsesInput` (`case "tool_use": … call_id: block.id`).
- Retain the emitted id tuple **separately from `funcCallByItemId`** — completed calls are
  deleted from that map during streaming and the remainder is cleared in `finalize()`.
- On the next request, derive the lookup key from the last assistant turn's tool-call id tuple,
  and inject only a matching entry, immediately before that assistant turn (this composes with
  the splice fix already in place).
- If no stable tool-call id is available, **skip reasoning reuse for that transition.**
  Correctness outranks reuse. This forfeits reuse on text-only assistant turns; P0.6 measures
  how often that costs anything.
- Fix the stale-write bug in the same change: `setReasoningItems` is currently called only
  `if (s.newReasoningItems.length)`, so a turn returning no reasoning leaves a previous turn's
  blobs in place. Store an explicit empty result or delete the entry.

**Tests** (none may permit reasoning produced for one id tuple to be returned for another):
two simultaneous conversations with **identical** first-user prompts but different call ids;
out-of-order completion; multiple call ids in one turn; a text-only assistant response; a turn
with no new reasoning; cache expiry; a resumed transcript.

---

## 6. Fix A — `cch` normalization: **do not implement yet**

Rewriting the per-request `cch=<hex>` stamp in the system prompt to a constant *looked* like the
dominant fix. Round 1 refuted the reasoning: cached tokens are non-zero despite `cch` diverging
at char 85, so the prefix model that justified it does not hold. Shipping it now would be a
system-prompt rewrite on unproven grounds.

Decide it from the Phase 0 trace:

- **If** `cacheRead` correlates with `cch` — implement narrowly: a dedicated normalizer touching
  only the recognized Claude Code metadata line, replacing exactly one `cch=[0-9a-f]{5}` with a
  fixed-width constant, leaving version/entrypoint/subagent/`cc_prompt_id` and all user-authored
  text untouched. Log once if the line contains zero or multiple `cch` fields (so a format change
  surfaces instead of silently restoring old behaviour). Ship behind an explicit canary env flag
  first; promote to default-on only if normalized instruction hashes are stable except for the
  separately-identified swing, reuse rises on same-state transitions, the gain is attributable,
  and tool choice / completion / error rates do not regress.
- **If it does not move reuse — drop fix A.** Do not broaden the rewrite speculatively.

Widening to any other metadata field requires *all* of: observed varying within one run, an
exact recognized grammar, no repository consumer, and a measured benefit in isolation.

---

## 7. Also on the list, deliberately deferred

- **`reasoning.effort` flipping mid-conversation.** `effectiveReasoningEffort` lowers high-or-
  greater to `medium` on a detected compaction turn, changing the request shell. Record effort
  transitions and their `cacheRead` outcomes. Do **not** remove the compaction optimisation
  until a matched measurement shows the two surrounding misses cost more than it saves.
- **`store: false` / `previous_response_id`.** Leave alone. The adapter deliberately sends a
  stateless request; server-side retention is a separate correctness and privacy decision.
- **Do not remove either diagnostic probe.** They are how the next measurement happens.

---

## 8. Success criterion

`cacheRead` grows with transcript depth instead of sitting at 3712/5760, and median hit ratio on
requests with input ≥20k moves from 6.7% to well north of 50%.

Re-measure with:

```bash
grep '^\[codex\] stream done' ~/.claude-proxy/proxy.log.fallback | tail -20
```

## 9. Two open threads

- The `toResponsesInput` splice fix (§0) has **never been adversarially reviewed**. Worth one
  `adversary` pass before this is committed.
- A matched wall-clock A/B between `luna@max` and a sonnet agent was **not** established. The
  attempt used different briefs (47 tool calls / 2603s vs 4 tool calls / 75s) and measures task
  size as much as lane speed. A real comparison needs an identical brief on both lanes, and
  cache logging added to `anthropic-pass.ts`, which currently logs none — there is no
  Anthropic-side cache number to compare against.
