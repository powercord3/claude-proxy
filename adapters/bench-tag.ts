// Benchmark run tagging (bench PLAN.md S-T12, §2.4.2; transport-only mode for the stock arm, §2.4).
//
// A benchmark run points ANTHROPIC_BASE_URL at  http://127.0.0.1:17870/bench/<run_tag>
// (or .../bench/<run_tag>/direct for the stock arm). Every child process inherits that URL, so
// every request the run causes arrives under the prefix without any child cooperating. The
// prefix is stripped before routing (Fastify rewriteUrl), so the request is handled exactly like
// a normal one; the parsed context rides on the raw request and is stamped onto both
// served.jsonl lines.
//
// A path prefix was chosen over a per-run port: the gateway is one Fastify process on one port
// with a PID lock and launcher scripts built around that port, so a port per run would mean a
// second listener lifecycle to manage. A prefix costs one URL rewrite and needs no restart per run.
//
// A malformed or empty tag is NOT dropped: the request is routed normally and its served lines
// carry run_tag:null, bench_untagged:true and the offending segment, so a runner can count it.

export interface BenchContext {
  /** Valid run tag, or null when the bench prefix carried a malformed/empty one. */
  runTag: string | null;
  untagged: boolean;
  /** The segment that failed validation (truncated), only when untagged. */
  rawTag?: string;
  /** Stock-arm transport-only mode: no alias resolution, no effort-suffix rewriting. */
  direct: boolean;
}

const TAG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
// Segments that would make ".../bench/v1/messages" or ".../bench/direct/v1/..." read as a tag.
const RESERVED = new Set(["v1", "direct"]);
const BENCH_PREFIX = "/bench/";

/**
 * Parse a request URL. Returns null when the URL is not on the bench prefix (the request is
 * then untouched); otherwise the context and the URL with the prefix stripped.
 */
export function parseBenchUrl(url: string): { ctx: BenchContext; url: string } | null {
  if (!url.startsWith(BENCH_PREFIX)) return null;
  const rest = url.slice(BENCH_PREFIX.length);
  const slash = rest.indexOf("/");
  let seg = slash === -1 ? rest : rest.slice(0, slash);
  let tail = slash === -1 ? "" : rest.slice(slash); // starts with "/" or is empty
  // A query string glued to the tag segment belongs to the tail.
  const q = seg.indexOf("?");
  if (q !== -1) {
    tail = seg.slice(q) + tail;
    seg = seg.slice(0, q);
  }
  let decoded = seg;
  try {
    decoded = decodeURIComponent(seg);
  } catch {
    /* keep the raw segment; it fails validation below */
  }

  let runTag: string | null = null;
  let untagged = false;
  let rawTag: string | undefined;
  let direct = false;

  if (RESERVED.has(decoded)) {
    // No tag at all: /bench/v1/... or /bench/direct/... . Re-attach the segment to the path.
    untagged = true;
    rawTag = "";
    tail = "/" + seg + tail;
  } else if (TAG_RE.test(decoded)) {
    runTag = decoded;
  } else {
    untagged = true;
    rawTag = decoded.slice(0, 128);
  }

  if (tail === "/direct" || tail.startsWith("/direct/") || tail.startsWith("/direct?")) {
    direct = true;
    tail = tail.slice("/direct".length);
  }
  if (!tail.startsWith("/")) tail = "/" + tail;

  const ctx: BenchContext = { runTag, untagged, direct };
  if (untagged) ctx.rawTag = rawTag;
  return { ctx, url: tail };
}

/** Fastify rewriteUrl hook: strip the bench prefix and remember the context on the raw request. */
export function benchRewriteUrl(req: { url?: string }): string {
  const url = req.url ?? "/";
  const parsed = parseBenchUrl(url);
  if (!parsed) return url;
  (req as any).ccxBench = parsed.ctx;
  if (parsed.ctx.runTag !== null) noteBenchRun(parsed.ctx.runTag);
  return parsed.url;
}

export function benchContextOf(raw: unknown): BenchContext | undefined {
  return (raw as any)?.ccxBench;
}

// Runs seen recently on this port. A request that arrives OFF the bench prefix while any run is
// active is an untagged benchmark request (PLAN S-T12: counted, never dropped silently): a child
// that dropped its inherited base URL still spends against some run's cap. The gateway cannot
// know which run on a shared port, so the line names every run active at that moment.
const ACTIVE_WINDOW_MS = Number(process.env.CCX_BENCH_ACTIVE_MS) > 0
  ? Number(process.env.CCX_BENCH_ACTIVE_MS)
  : 30 * 60 * 1000;
const activeRuns = new Map<string, number>();

export function noteBenchRun(tag: string, now: number = Date.now()): void {
  activeRuns.set(tag, now);
}

/** Run tags seen within the active window, oldest entries pruned. */
export function activeRunTags(now: number = Date.now()): string[] {
  const out: string[] = [];
  for (const [tag, seen] of activeRuns) {
    if (now - seen > ACTIVE_WINDOW_MS) activeRuns.delete(tag);
    else out.push(tag);
  }
  return out.sort();
}

/**
 * The served.jsonl fields for this request. run_tag is always present (null off the bench
 * prefix) so a consumer can filter on one key. The x-bench-run-tag header is a cross-check
 * only: the path decides run_tag, and a disagreement is flagged, never silently resolved.
 */
export function benchFields(
  ctx: BenchContext | undefined,
  headers: Record<string, unknown> | undefined,
  now: number = Date.now(),
): Record<string, unknown> {
  const h = headers?.["x-bench-run-tag"];
  const headerTag = typeof h === "string" && h !== "" ? h.slice(0, 128) : null;
  const out: Record<string, unknown> = { run_tag: ctx?.runTag ?? null };
  if (ctx) {
    out.bench = true;
    if (ctx.untagged) {
      out.bench_untagged = true;
      out.bench_raw_tag = ctx.rawTag ?? "";
    }
    if (ctx.direct) out.transport_only = true;
  } else {
    const active = activeRunTags(now);
    if (active.length > 0) {
      out.bench_untagged = true;
      out.bench_off_prefix = true;
      out.active_run_tags = active;
    }
  }
  if (headerTag !== null) {
    out.header_run_tag = headerTag;
    out.run_tag_mismatch = headerTag !== (ctx?.runTag ?? null);
  }
  return out;
}

// Provider keys accepted in transport-only mode. An unknown prefix must be refused: the
// gateway's dispatch falls through to the GLM lane for anything it does not recognise, which
// would silently serve a different model than the one the stock arm asked for.
const DIRECT_PROVIDERS = new Set([
  "openai", "openrouter", "gemini", "gemini-oauth", "codex-oauth", "glm", "anthropic", "cline-pass", "deepseek",
]);

const DIRECT_EFFORT = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);

/**
 * Transport-only resolution: the model string must already be "provider:model[@effort]". No
 * alias is expanded and no default is substituted, so the served target is exactly the id named.
 * A trailing @effort is split off into `reasoning` (it is part of the direct id's contract, not
 * a model slug: leaving it in would send e.g. "gpt-5.5@high" upstream as a literal model id);
 * served.jsonl re-joins it, so requested == resolved still holds.
 *
 * A bare "claude-*" id is Claude Code's own internal request (Explore agent, title generation;
 * map.ts PROVIDER_FAST_MODEL comment). The stock arm keeps those built-ins, so it is served
 * verbatim on the anthropic lane rather than refused or remapped to another provider.
 * Returns an error string instead of guessing.
 */
export function parseDirectModel(
  field: unknown,
): { provider: string; model: string; reasoning?: string } | { error: string } {
  if (typeof field !== "string" || field === "") return { error: "transport-only mode needs a model" };
  let id = field;
  let reasoning: string | undefined;
  const at = id.lastIndexOf("@");
  if (at > 0 && DIRECT_EFFORT.has(id.slice(at + 1).toLowerCase())) {
    reasoning = id.slice(at + 1).toLowerCase();
    id = id.slice(0, at);
  }
  const withEffort = (r: { provider: string; model: string }) => (reasoning ? { ...r, reasoning } : r);
  if (!id.includes(":") && id.toLowerCase().startsWith("claude-")) {
    return withEffort({ provider: "anthropic", model: id });
  }
  const i = id.indexOf(":");
  if (i <= 0 || i === id.length - 1) {
    return { error: `transport-only mode needs a provider-qualified id "provider:model", got "${field}"` };
  }
  const provider = id.slice(0, i);
  if (!DIRECT_PROVIDERS.has(provider)) {
    return { error: `transport-only mode: unknown provider "${provider}" in "${field}"` };
  }
  return withEffort({ provider, model: id.slice(i + 1) });
}
