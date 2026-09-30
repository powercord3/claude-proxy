// Durable per-request record of which model actually served a request.
// One JSON line per /v1/messages request in ~/.claude-proxy/served.jsonl, written at the point
// the alias has resolved to provider:model@effort. Fail-open: any error is swallowed.
// Usage tokens are not recorded here (the response path is per-adapter); ts+request_id let a
// follow-up line be joined later.
import { appendFileSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { randomUUID } from "crypto";

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
  };
}

export function recordServed(r: ServedRecord): void {
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    appendFileSync(SERVED_LOG_PATH, JSON.stringify(buildServedLine(r)) + "\n");
  } catch {
    /* fail-open: logging must never break a request */
  }
}
