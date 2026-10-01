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
