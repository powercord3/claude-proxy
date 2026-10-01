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
