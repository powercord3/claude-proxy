// Durable per-request record of which model actually served a request.
// Two JSON lines per /v1/messages request in ~/.claude-proxy/served.jsonl, joined by request_id:
//   1. the request line, written where the alias has resolved to provider:model@effort;
//   2. a kind:"completion" line, written when the reply closes: usage, reasoning tokens,
//      timings, stop_reason and HTTP status.
// Fail-open: any error is swallowed. Only counters are kept; prompt and response text are
// parsed and discarded, never stored or logged.
import { appendFileSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { randomUUID } from "crypto";
import { StringDecoder } from "string_decoder";

const STATE_DIR = join(homedir(), ".claude-proxy");
const SERVED_LOG_PATH = process.env.CCX_SERVED_LOG || join(STATE_DIR, "served.jsonl");

export interface ServedRecord {
  requested: string | undefined;
  provider: string;
  model: string;
  reasoning?: string;
  serviceTier?: string;
  inEffort?: string;
  lane?: string;
  stream?: boolean;
  headers?: Record<string, unknown>;
  rerouted?: boolean;
  fallbackHop?: number;
  /** Extra fields stamped onto the line, e.g. the bench run tag (bench-tag.ts, S-T12). */
  extra?: Record<string, unknown>;
}

export function buildServedLine(r: ServedRecord, now: Date = new Date()): Record<string, unknown> {
  const h = r.headers ?? {};
  const pick = (k: string) => (typeof h[k] === "string" ? (h[k] as string) : undefined);
  return {
    ts: now.toISOString(),
    request_id: pick("x-client-request-id") ?? pick("x-request-id") ?? randomUUID(),
    session_id: pick("x-claude-code-session-id") ?? null,
    requested: r.requested ?? null,
    resolved: `${r.provider}:${r.model}${r.reasoning ? `@${r.reasoning}` : ""}`,
    provider: r.provider,
    model: r.model,
    effort: r.reasoning ?? null,
    client_effort: r.inEffort ?? null,
    service_tier: r.serviceTier ?? null,
    lane: r.lane ?? r.provider,
    stream: r.stream === true,
    rerouted: r.rerouted === true,
    fallback_hop: r.fallbackHop ?? -1,
    ...(r.extra ?? {}),
  };
}

// Last resolution seen per requested alias, so the line after a repoint names the change
// (bench PLAN.md S-T03: the record must name the alias change, not just the new model).
// In-memory: the first request after a proxy restart has no previous value to compare.
const lastResolved = new Map<string, string>();

/** Adds alias_changed / previous_resolved when `requested` now resolves differently. */
export function noteAliasChange(line: Record<string, unknown>, r: ServedRecord): void {
  // A fallback hop or classifier reroute changes the target for reasons other than a repoint.
  if (r.rerouted === true || (r.fallbackHop ?? -1) >= 0) return;
  if (typeof r.requested !== "string" || r.requested === "") return;
  const resolved = line.resolved as string;
  if (resolved === r.requested) return; // not an alias: nothing was resolved
  const key = r.requested.toLowerCase();
  const prev = lastResolved.get(key);
  lastResolved.set(key, resolved);
  if (prev !== undefined && prev !== resolved) {
    line.alias_changed = true;
    line.previous_resolved = prev;
  }
}

function appendLine(line: Record<string, unknown>): void {
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    appendFileSync(SERVED_LOG_PATH, JSON.stringify(line) + "\n");
  } catch {
    /* fail-open: logging must never break a request */
  }
}

/** Writes the request line and returns its request_id (null only if building it failed). */
export function recordServed(r: ServedRecord): string | null {
  try {
    const line = buildServedLine(r);
    noteAliasChange(line, r);
    appendLine(line);
    return line.request_id as string;
  } catch {
    return null;
  }
}

type Usage = Record<string, any>;
const MAX_BUFFER = 4 * 1024 * 1024;

/**
 * Observes the Anthropic-shaped reply every adapter writes to `raw` (SSE for streams, one JSON
 * body otherwise) and appends the completion line when the reply closes.
 */
export class CompletionTap {
  private decoder = new StringDecoder("utf8");
  private pending = "";
  private sawSse = false;
  private jsonBuf = "";
  private jsonOverflow = false;
  private usage: Usage = {};
  private stopReason: string | null = null;
  private thinkingChars = 0;
  private firstTokenAt: number | null = null;
  private lastTokenAt: number | null = null;
  private done = false;

  constructor(
    private requestId: string,
    private startMs: number,
    private now: () => number = Date.now,
    /** Fields repeated on the completion line, e.g. run_tag (S-T12). */
    private extra: Record<string, unknown> = {},
  ) {}

  /** Patch raw.write/raw.end to observe output; the completion line is emitted on close. */
  attach(raw: any): void {
    try {
      const write = raw.write.bind(raw);
      const end = raw.end.bind(raw);
      raw.write = (chunk: any, ...rest: any[]) => {
        this.feed(chunk);
        return write(chunk, ...rest);
      };
      raw.end = (chunk?: any, ...rest: any[]) => {
        if (chunk != null && typeof chunk !== "function") this.feed(chunk);
        return end(chunk, ...rest);
      };
      raw.once("close", () => this.finish(raw.statusCode, raw.writableFinished === true));
    } catch {
      /* fail-open */
    }
  }

  feed(chunk: any): void {
    try {
      if (chunk == null) return;
      const t = this.now();
      const text = typeof chunk === "string" ? chunk : this.decoder.write(Buffer.from(chunk));
      if (!this.sawSse && this.pending === "" && this.jsonBuf === "" && /^\s*(event|data):/.test(text)) {
        this.sawSse = true;
      }
      if (this.sawSse) {
        this.pending += text;
        let i: number;
        while ((i = this.pending.indexOf("\n")) >= 0) {
          const ln = this.pending.slice(0, i).replace(/\r$/, "");
          this.pending = this.pending.slice(i + 1);
          if (ln.startsWith("data:")) this.onData(ln.slice(5).trim(), t);
        }
        if (this.pending.length > MAX_BUFFER) this.pending = "";
      } else if (!this.jsonOverflow) {
        this.jsonBuf += text;
        if (this.jsonBuf.length > MAX_BUFFER) {
          this.jsonOverflow = true;
          this.jsonBuf = "";
        }
      }
    } catch {
      /* fail-open */
    }
  }

  private mergeUsage(u: Usage | undefined): void {
    if (!u || typeof u !== "object") return;
    for (const [k, v] of Object.entries(u)) {
      if (k === "cache_creation" && v && typeof v === "object") {
        this.usage.cache_creation = { ...this.usage.cache_creation, ...(v as object) };
      } else if (typeof v === "number") {
        this.usage[k] = v;
      }
    }
  }

  private onData(data: string, t: number): void {
    if (!data || data === "[DONE]") return;
    let j: any;
    try {
      j = JSON.parse(data);
    } catch {
      return;
    }
    switch (j?.type) {
      case "message_start":
        this.mergeUsage(j.message?.usage);
        break;
      case "content_block_delta": {
        if (this.firstTokenAt === null) this.firstTokenAt = t;
        this.lastTokenAt = t;
        const d = j.delta;
        if (d?.type === "thinking_delta" && typeof d.thinking === "string") this.thinkingChars += d.thinking.length;
        break;
      }
      case "message_delta":
        this.mergeUsage(j.usage);
        if (j.delta?.stop_reason) this.stopReason = j.delta.stop_reason;
        break;
    }
  }

  private parseJsonBody(): void {
    if (this.sawSse || this.jsonOverflow || !this.jsonBuf) return;
    try {
      const j = JSON.parse(this.jsonBuf);
      this.mergeUsage(j?.usage);
      if (typeof j?.stop_reason === "string") this.stopReason = j.stop_reason;
      for (const b of Array.isArray(j?.content) ? j.content : []) {
        if (b?.type === "thinking" && typeof b.thinking === "string") this.thinkingChars += b.thinking.length;
      }
    } catch {
      /* error bodies and the like */
    }
  }

  buildLine(status: number | undefined, finished: boolean): Record<string, unknown> {
    this.parseJsonBody();
    const end = this.now();
    const u = this.usage;
    const out = typeof u.output_tokens === "number" ? u.output_tokens : null;
    const ttft = this.firstTokenAt !== null ? this.firstTokenAt - this.startMs : null;
    // Generation time: first token to end of reply; output_tokens / that is decode throughput.
    const genMs = this.firstTokenAt !== null ? end - this.firstTokenAt : null;
    const reported = typeof u.reasoning_tokens === "number" ? u.reasoning_tokens : null;
    const estimate = reported === null && this.thinkingChars > 0;
    return {
      kind: "completion",
      ts: new Date(end).toISOString(),
      request_id: this.requestId,
      start_ts: new Date(this.startMs).toISOString(),
      http_status: status ?? null,
      finished,
      stop_reason: this.stopReason,
      usage: {
        input_tokens: u.input_tokens ?? null,
        cache_read_input_tokens: u.cache_read_input_tokens ?? null,
        cache_creation_input_tokens: u.cache_creation_input_tokens ?? null,
        ephemeral_5m_input_tokens: u.cache_creation?.ephemeral_5m_input_tokens ?? null,
        ephemeral_1h_input_tokens: u.cache_creation?.ephemeral_1h_input_tokens ?? null,
        output_tokens: out,
      },
      reasoning_tokens: reported,
      reasoning_tokens_est: estimate ? Math.ceil(this.thinkingChars / 4) : null,
      reasoning_tokens_is_estimate: estimate,
      time_to_first_token_ms: ttft,
      total_ms: end - this.startMs,
      output_tokens_per_s:
        out !== null && genMs !== null && genMs > 0 ? Math.round((out / (genMs / 1000)) * 100) / 100 : null,
      ...this.extra,
    };
  }

  finish(status: number | undefined, finished: boolean): void {
    if (this.done) return;
    this.done = true;
    try {
      appendLine(this.buildLine(status, finished));
    } catch {
      /* fail-open */
    }
  }
}
