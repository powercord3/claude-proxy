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
