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
