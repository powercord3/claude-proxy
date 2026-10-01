Cache fix (2026-09-06, agent run; raw evidence ~/.claude/jobs/688c7988/tmp/exp3/).

MECHANISM (refutes H4 and the side-call theory): the ChatGPT Codex backend keeps no replica
affinity on prompt_cache_key alone. Byte-identical deep request replayed sequentially, same key:
cacheRead 3712,44672,5760,44672,5760,44672 (7 hits / 12). 3712 = backend preamble only.
Codex CLI also sends conversation_id + session_id headers (codex-rs/core/src/client.rs); the
proxy sent neither. Side-calls only add one more routing roll per turn; not causal.

FIX: codex-oauth.ts ~L1018-1029 sends conversation_id = session_id = prompt_cache_key.
Default ON; opt-out CCX_CODEX_SESSION_HEADERS=0. Diagnostics behind CCX_CACHE_DEBUG=1.
Backup codex-oauth.ts.bak-cachefix-20260906-003936. Tests 90/90, tsc clean.

VERIFIED on rig: identical-request hits 12/12; subagent-path cacheRead now monotone
(3712 ... 21120,24192,26240,28288,31360,36480); headless to 82560 over 21 requests.
Residual ~1 miss per 10-20 requests. NOT live until the 17870 proxy restarts.
