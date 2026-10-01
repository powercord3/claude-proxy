# Codex cost work order #3 — the quadratic cost is fixed, and here is what was wrong

Written 2026-09-06, same day as `CODEX-COST-WORK-2.md`.

**This file overturns one conclusion in work order #2 and closes its section 3 experiment.**
Read section 1 before anything else. Work order #2's section 5 "do not re-derive" list needs one
line struck, and section 2's headline conclusion needs a scope qualifier; both are stated below.

---

## 1. What was wrong, and what fixed it

### 1.1 The correction

Work order #2 section 2 concluded, in bold: *"Server-side conversation state is unavailable on
this endpoint. The full-transcript re-upload is structural. Only miss frequency and miss cost are
controllable."*

The first sentence is correct and the emphasis is doing real work: **on this endpoint**. The
second and third sentences do not follow from it, because the backend has another endpoint.

`https://chatgpt.com/backend-api/codex/responses` refuses `previous_response_id` with
`400 Unsupported parameter`. That was measured correctly. But the same host also speaks
`wss://chatgpt.com/backend-api/codex/responses`, and **on the WebSocket transport
`previous_response_id` is accepted**. Codex CLI has used it all along
(`codex-rs/codex-api/src/endpoint/responses_websocket.rs`, `codex-rs/core/src/client.rs`); the
proxy simply never spoke that transport.

So the re-upload was never structural. It was a property of the transport we had chosen.

This is also the resolution of work order #2 section 3's unsubstantiated Discord claim. The
claim was framed as "the Codex SDK avoids the quadratic cost", and section 3.1's prior guessed
the mechanism would turn out to be cache-affinity continuity that this proxy already had. That
prior was wrong. The mechanism is a different transport with a different parameter allowlist,
and the section 3.2 "kill criteria" would have wrongly killed the investigation, because they
were all framed around an npm SDK package rather than around the wire protocol. **The thing to
have read was the CLI's own transport layer, which was on disk the whole time.**

### 1.2 What is measured

Two interleaved ws/http pairs, 12 turns each, ~35k-token prefix, one tool call per turn,
identical task and account, one time window. Interleaving discipline per work order #2 section
3.3, which is why this is reported as pairs and not as a single ratio.

| run | full-price input | uploaded | prompt-cache misses |
|---|---|---|---|
| ws pair 1 | 56,460 | 131 KiB | 0/10 |
| http pair 1 | 56,460 | 1,200 KiB | 0/10 |
| ws pair 2 | 56,460 | 131 KiB | 0/10 |
| http pair 2 | **91,097** | 1,210 KiB | **1/10** |

Two independent effects, and it matters that they are separate:

**Uploaded bytes fall from O(N²) to O(N).** Only the delta goes on the wire. 9x at 12 turns, and
the ratio grows linearly with turn count. This one is deterministic — both ws runs uploaded 131
KiB — and needs no statistics.

**Cache misses stop happening.** Both WebSocket runs returned *byte-identical* totals with zero
misses; HTTP varied and took one miss costing a 34,637-token re-prefill, +61% on that run. The
mechanism is the one work order #2 section 1.3 already identified as binding: a WebSocket is one
TCP connection to one replica, so the replica-routing roll is taken **once at connect** instead
of once per request. Section 1.3's climb-then-collapse pattern requires a mid-conversation
reroute to trigger. A pinned socket does not offer one.

Two pairs is a small sample and the zero-variance result is the reason it is reportable: the
noise band work order #2 section 3.3 demanded be stated from data is, on the ws side of this
experiment, exactly zero across two runs.

### 1.3 End-to-end, through the real adapter

Six turns driven through `chatCodexOAuth` itself against the live backend (no server, no pid
file, live proxy untouched), each turn feeding back a tool result the way Claude Code would:

```
turn 0  full         sent   0.8 KiB   full-price input 875   cacheRead  3,712
turn 1  INCREMENTAL  sent  66.0 KiB   full-price input 209   cacheRead 25,216
turn 2  INCREMENTAL  sent   1.0 KiB   full-price input 253   cacheRead 25,216
turn 3  INCREMENTAL  sent   1.0 KiB   full-price input 297   cacheRead 25,216
turn 4  INCREMENTAL  sent   1.0 KiB   full-price input 341   cacheRead 25,216
turn 5  INCREMENTAL  sent   1.0 KiB   full-price input 385   cacheRead 25,216
```

Turn 1 is legitimately large because its tool result genuinely is 66 KiB of new content; that is
the delta working correctly, not failing to. Full-price input grows ~44 tokens per turn, which is
the delta itself.

The same harness re-run with `CCX_CODEX_WS=0` is the matched control, and it is the honest
version of the comparison because it changes exactly one thing:

| path | full-price input, 6 turns | upload per turn, turns 2–5 |
|---|---|---|
| WebSocket | 2,360 | 1.0 KiB |
| HTTPS control | 2,376 | 66.5–68.8 KiB |

Note what this control does **not** show: no cache miss happened on either side, so the token
columns match. That is the expected result for a six-turn run and it is why section 1.2's twelve-
turn pairs, where a miss did occur, carry the cost claim. What this control establishes is that
the delta is not silently dropping content — same conversation, same billed input, 66x less
uploaded.

The control also cleared a false alarm worth recording. The end-to-end run showed the
encrypted-reasoning cache empty (`cache=0`) on every turn, where the live proxy log shows it
populated on 10,987 requests. Running the control with the transport off reproduced `cache=0` on
the same turns and `cache=1` on turn 5, so the instrument can report a positive and the empty
cache is the backend declining to emit a reasoning item on these low-effort turns. It is not a
regression from this change.

Compare the same shape in work order #2 section 1.3: ~110,365 full-price input per turn, and
2,206,859 tokens across the ten turns after a single miss.

---

### 1.4 Live on 17870 since 2026-09-06 16:52

Restarted and confirmed serving. First live traffic, `luna@max`, 8-turn sequential-read loop,
run twice:

```
             wall    median TTFT   full-price input   cache reads
luna@max A   18.5s        2,308ms             45,291       215,040
luna@max B   27.1s        2,779ms             45,391       215,040
```

Per-turn full-price input after the opening document is ~3,000 tokens and `cacheRead` climbs
monotonically, 3,712 → 28,288 → 31,360 → 33,408 → 35,456 → 38,528 → 40,576. No collapse. Work
order #2 section 1.3 measured the same lane at ~110,365 full-price input **per turn** with the
climb collapsing to the preamble mid-run.

The INCREMENTAL ratio that open item 2 says to watch is healthy on real traffic: **14 incremental
turns to 3 full**, and all 3 full turns are the legitimate opening turn of a conversation. The
deepest turn uploaded 7.7 KiB where the HTTPS path would have uploaded 106.9 KiB.

The two runs differ by 100 tokens of full-price input and are identical on cache reads, which is
the same zero-variance signature as section 1.2. Wall clock is the noisy axis, not cost.

---

## 2. What is on disk

Committed as `4933441` and **live on 17870 since the 16:52 restart**.

- `adapters/providers/codex-ws.ts` — new. The transport. Connection pool, content-addressed
  session matching, delta calculation, and the fallback contract. Read its header comment for the
  design rationale; read the `Baseline` comment for the part most likely to be subtly wrong.
- `adapters/providers/codex-oauth.ts` — the OAuth lane tries the WebSocket first and falls back
  to the existing HTTPS path on any failure. `pumpResponsesStream` was refactored so both
  transports share `consumeResponsesEvents`, deliberately: a diagnostic that exists on only one
  transport cannot be used to compare them. Backup:
  `codex-oauth.ts.bak-ws-20260906`.
- `tests/codex-ws.test.ts` — new, 19 tests. Drives the real `runCodexWsTurn` against a scripted
  fake socket rather than testing an extracted delta function, because the delta and the baseline
  are only correct *together* and a unit test of either half would pass while the pair disagreed.

`npx vitest run` → 171/171. `npx tsc --noEmit` → clean.

### 2.2 What the adversarial review changed

One reviewer finding was raised as critical baseline corruption and is **refuted**, with the two
tests that refute it now in the suite. Its mechanical half was correct and is worth knowing: when
`handleEvent` throws on `response.failed`/`response.incomplete`, the consumer's `for await` calls
`.return()` on the turn generator, which resumes at the `yield` with a return completion, runs
`finally`, and **skips the baseline commit block above it**. The inferred consequence — that a
later turn resumes from a corrupted chain — does not follow. The retained baseline describes the
server's context at the last *completed* response, and a response that failed does not
retroactively change that context. Skipping the commit therefore keeps a correct older baseline
rather than writing a wrong new one, which is the fail-safe direction. The tests assert it on the
wire: after a truncated turn, the next request carries `previous_response_id: resp-1` and a delta
that still includes the tool result the abandoned turn had already sent.

Two findings held and are fixed:

- **Session cap TOCTOU.** `sessions.length >= MAX_SESSIONS` was checked before an `await` and
  enforced after it, so two concurrent turns could both pass and open a 9th socket. A
  `pendingConnects` counter now covers the window.
- **Stuck-busy sessions.** `busy` is only cleared in the generator's `finally`, which needs
  something to iterate the generator. Every caller does, so this was latent, but a future caller
  that abandoned a turn would strand the session and shrink the pool permanently. `reapSessions`
  now closes a session whose turn has been in flight for more than twice the stream idle timeout.

One finding is accepted and not fixed, because it fails safe: an assistant turn that interleaves
text and tool calls, or one affected by the trailing-developer reorder in
`normalizeMessagesForResponses`, reconstructs into a different item grouping than the server's
output items were recorded as. The strict-prefix check detects the divergence and resends in
full. That costs the delta on those turns, it does not corrupt anything, and it is the first
thing to look at if open item 2 below shows a poor INCREMENTAL ratio.

The prefix matcher was mutation-tested: inverting its comparison makes
*"resends in full when an earlier item changed rather than being appended to"* fail and the other
18 pass, so that test discriminates rather than merely passing.

### 2.1 Safety posture

The transport cannot fail a request. `runCodexWsTurn` resolves only once the first response frame
has arrived, so every earlier failure — connect timeout, the 1008 policy close reported against
Codex CLI on some networks, an `error` frame, an expired `previous_response_id` — returns null
and the caller uses the HTTPS path it would have used anyway, with nothing yet written
downstream.

A transport failure disables WebSockets for the life of the process, mirroring
`disable_websockets` in `codex-rs/core/src/client.rs`, so one bad network pays the connect
timeout once rather than every turn. An expired `previous_response_id` is explicitly **not**
treated as a transport failure: it is an ordinary consequence of the server's connection-local
cache, and must not cost the process its transport.

Default ON, opt out with `CCX_CODEX_WS=0`. Default-on is a deliberate departure from the
stage-then-promote pattern used for `CCX_NORMALIZE_CCH` and `CCX_PROMPT_CACHE_KEY_V2`: those
flags changed what was sent on a path with no fallback, so a bad promotion was a live incident.
This one has a fallback that reproduces the previous behaviour exactly, so leaving it off by
default would mean the fix does not apply while carrying the same risk on the day it is turned
on.

The API-key lane is untouched and still uses HTTPS. The WebSocket endpoint measured here is the
ChatGPT backend's; nothing establishes that `api.openai.com` negotiates the same transport with
the same beta header, and that is an open question rather than a settled negative.

---

## 3. Things this changes about work orders #1 and #2

**Strike from work order #2 section 5 ("do not re-derive"):** *"Server-side state is refused four
ways on this endpoint."* Keep the sentence, but it is now load-bearing only as written, about
that endpoint. It was being read as a fact about the backend.

**Work order #2 section 4 item 1 is unaffected and still the highest-value pending action:** the
staged `CCX_NORMALIZE_CCH` default-on change still needs the 17870 restart, and now so does this.
One restart covers both.

**Work order #2 section 4 items 3 and 6 are now much lower value.** `context_management:
compaction` and the reasoning-splice A/B were both attempts to reduce the cost of re-uploading a
transcript we no longer re-upload. Retest them only if the WebSocket transport turns out not to
hold up in production.

**Work order #2 section 4 item 2 is done in passing and worth keeping.** The richer `usage`
telemetry it asked for — `input_tokens_details.cached_tokens` and the `attribution` map giving
per-request-field and per-item cache breakdown — is confirmed present on both transports. The
`attribution.request_fields.instructions` entry is what proves an instructions-only cache hit
without inferring it from a probe.

---

## 4. Open, ranked

1. **Restart 17870.** Blocked on user approval. Now carries two changes: the staged
   `CCX_NORMALIZE_CCH` default-on, and this transport. Use the proven fallback in
   `PROMPT-CACHE-WORK.md` section 1 — pid from the port, never from `proxy.pid`, and
   stop/start/poll/fallback in one call.
2. **Watch the first real fleet session for `ws turn INCREMENTAL` vs `ws turn full` ratio.** A
   run that logs `full` on most turns means the delta is being refused, and the reason will be
   one of: the request shell changing per turn, or `toResponsesInput` emitting something that
   breaks the strict-prefix property. Both are diagnosable from the existing log line.
3. **Idle connection cost is unmeasured.** Sessions are held up to 50 minutes and reaped at 10
   minutes idle. Whether many concurrent agents holding sockets draws any rate-limit or
   connection-count penalty on the subscription lane is not known; the published limit is 60
   minutes per connection, and nothing was measured about how many are tolerated at once.
4. ~~**Shutdown aborts with an open socket.**~~ **FIXED 2026-09-06.** Kept below because the
   measurement is the useful part. Two changes: `bin/lib/pid-manager.js` now defers the exit by
   an unref'd tick with a 2s hard stop, and `codex-ws.ts` registers SIGINT/SIGTERM/beforeExit
   handlers that close the pool, because deferring the exit only helps if something has asked the
   sockets to close by then. Verified against a real socket: the old shape gives
   `rc=127` plus the assertion, the new shape `rc=0`. **A graceful stop now takes ~2.5s rather
   than being instant**, because the listener holds the loop until the hard stop fires; a restart
   script that polls for the port to free needs to allow for that. A `taskkill /F` is unaffected,
   since it runs no handlers.

   The original finding follows. Measured, not inferred.
   `process.exit()` while a WebSocket handle is open dies with
   `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), src\win\async.c line 76` and exit code
   127. `bin/lib/pid-manager.js:132-133` does exactly that shape: `rm(); process.exit(0)` on
   SIGINT and SIGTERM.

   Impact is bounded — the `exit` handler runs *before* the assertion, so `proxy.pid` is still
   removed and no state is lost. What changes is that a clean stop now returns 127 instead of 0,
   which a restart script could read as a failed stop.

   Closing the socket and exiting one tick later is clean (verified: rc=0). Closing in the same
   tick is not, and neither is exiting with the socket simply left open — so the fix has to defer
   the exit, which means editing `pid-manager.js`, a file with unrelated uncommitted changes in
   the working tree. Left alone deliberately. The change is to replace the two signal handlers'
   `rm(); process.exit(0)` with `rm(); setTimeout(() => process.exit(0), 100)`, or to drop the
   explicit exit and let the loop drain.

5. **`CCX_STATE_DIR`** for `pid-manager.js` and `openai-auth.ts`, unchanged from work order #2
   item 5. Still the thing that would have made an isolated second proxy instance possible; this
   work routed around it by driving the adapter directly instead of running a second server.
6. **The `attribution` map is now worth logging.** It attributes a miss to a specific request
   field instead of inferring it from probes, and every future measurement here gets cheaper.

## 5. Do not re-derive

- The HTTPS endpoint refuses `previous_response_id`; the WebSocket endpoint accepts it. Both are
  measured, both are true, and the difference is the whole fix.
- `wss://chatgpt.com/backend-api/codex/responses`, handshake header
  `OpenAI-Beta: responses_websockets=2026-02-06`. Sending `responses=experimental` there does not
  negotiate the transport.
- Frames are `{"type":"response.create", ...}` carrying the same body the HTTPS path sends, plus
  an optional `previous_response_id`. Responses arrive as the ordinary Responses streaming events,
  one JSON object per frame, plus `codex.rate_limits`, `codex.response.metadata` and
  `responsesapi.websocket_timing` frames that are not part of the public event model.
- An unknown `previous_response_id` returns an `error` frame with
  ``Invalid `previous_response_id`.``, not a close. That is the control proving the instrument can
  report a negative.
- Node 22+ has a global `WebSocket` that accepts a `headers` option. No dependency was added.
- **An open socket holds the Node event loop.** A process with a pooled session does not exit on
  its own until the session is reaped. Irrelevant to the proxy, which is a long-lived server, and
  the reason the end-to-end script above had to be run under `timeout`. Anything short-lived that
  imports this adapter needs to close the pool or accept the hang.
- Latency was never the problem and still is not. Cost was, and the miss was the expensive part.
