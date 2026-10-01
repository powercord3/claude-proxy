Post-round-2 measurement (2026-09-05, run by implementer subagent; raw logs in
~/.claude/jobs/688c7988/tmp/exp2/). Not yet argued in the room.

A. Throughput, 1500-word essay, no tools. tok/s = output/(totalMs/1000) from stream done lines.
 gateway luna@max standard   4603 tok / 83.7 s = 55.0 ; repeat 4978 / 90.1 = 55.3
 gateway luna@max PRIORITY   2956 / 54.0 = 54.8   (service_tier=priority confirmed applied)
 gateway luna@medium         2262 / 44.5 = 50.8
 codex exec direct luna@max  3795 / 61.6 = 61.6   (2956 text + 839 reasoning)
 -> tier changes nothing; proxy path costs ~12%; backend itself serves ~55-62 tok/s, not 125.

B. Agentic task (task.md), parallelism off, alternating, all four correct:
 max  157.5 s / 11 turns / 7021 out tok ; max  175.9 s / 12 / 6214
 med   99.7 s / 12 turns / 3142 out tok ; med  101.8 s / 13 / 3260
 -> medium = ~60% of max wall-clock, same answer. Effort-sensitive share of wall 72-88%.

Open for the next round: why the ChatGPT plus codex-oauth backend serves luna at ~60 tok/s
when public benchmarks (API serving) report ~125; whether the API-key lane
(api.openai.com/v1/responses, codex-oauth.ts:46-47) reaches 125 on the same prompt.
