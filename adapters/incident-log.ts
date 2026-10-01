// Incident correlation for the gateway's own failures.
//
// Per-request logging (proxy.log / provider-health.json) is fine for "what happened on this
// one call" but loses the shape of an outage once every lane recovers before anyone looks: a
// member who hits connection refusals across several providers at once, or a single org-policy
// denial, sees each as its own line and nothing tying them together. This module groups
// qualifying failures that land close together into one durable "incident" record and keeps
// that record after the lane(s) involved recover - see provider-health.ts for the per-lane
// down/ok state this complements; that module answers "is this ONE lane usable right now",
// this one answers "were these failures the same outage".
//
// Two classes only, matched on the raw error text (and, for a thrown fetch() failure, its
// `cause.code`):
//   transport-refusal  the network or the upstream process itself is unreachable
//                       (ECONNREFUSED/ECONNRESET/ETIMEDOUT/EAI_AGAIN, or a bare "fetch failed")
//   policy-denial       the account has been told no by an org policy, not by the network
// A denial and a refusal are not interchangeable signals - conflating them would make a
// genuine policy block look like a transient network blip - so they are kept as separate
// classes on the same incident rather than merged into one generic "failure" tag.
//
// Persisted as its own append-only JSONL log next to the gateway's existing logs
// (~/.claude-proxy/proxy.log), NOT through telemetry_lib.py: this process has no bridge into
// that Python-owned sink today, and building one is a separate, larger piece of work.
import { appendFileSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { randomUUID } from "crypto";

const STATE_DIR = join(homedir(), ".claude-proxy");
const INCIDENT_LOG_PATH = join(STATE_DIR, "incidents.jsonl");

export type IncidentClass = "transport-refusal" | "policy-denial";

// Failures further apart than this are unrelated events, not one ongoing outage - an isolated
// refusal an hour after the last one is a new problem, not the same incident still running.
const CORRELATION_WINDOW_MS = 2 * 60 * 1000;

const TRANSPORT_REFUSAL_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "ENOTFOUND",
]);
const TRANSPORT_REFUSAL_RE = /ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|fetch failed/i;
// Anthropic's own documented error taxonomy (https://docs.claude.com/en/api/errors) names this
// case "permission_error" - "the API key does not have permission to use the specified
// resource", which is exactly what an org disabling Claude access looks like from here. Matched
// on that structured `type` field because anthropic-pass.ts forwards the upstream body verbatim
// into the thrown message (see anthropic-pass.ts:257-262), so a real denial carries it; a guessed
// English sentence would not reliably match what Anthropic actually sends. 401/403 alone is NOT
// enough - apiError() throws those locally for missing/unset API keys too, which is a config
// problem, not an org policy denial.
const POLICY_DENIAL_RE = /"type"\s*:\s*"permission_error"/i;

/**
 * Classify a thrown failure's message (and, for a fetch() rejection, its `cause`) into one of
 * the two incident-worthy classes, or null when it qualifies for neither. Anything null is left
 * as the single per-request error it already was - it never opens or touches an incident.
 */
export function classifyIncident(message: string, cause?: unknown): IncidentClass | null {
  const causeCode = (cause as { code?: string } | undefined)?.code;
  if (causeCode && TRANSPORT_REFUSAL_CODES.has(causeCode)) return "transport-refusal";
  const text = String(message ?? "");
  if (POLICY_DENIAL_RE.test(text)) return "policy-denial";
  if (TRANSPORT_REFUSAL_RE.test(text)) return "transport-refusal";
  return null;
}

interface IncidentEvent {
  at: string;
  lane: string;
  kind: "failure" | "recovery";
  class?: IncidentClass;
  message?: string;
}

interface OpenIncident {
  id: string;
  opened_at: string;
  events: IncidentEvent[];
  /** Lanes with an unresolved failure - the incident closes once this is empty. */
  downLanes: Set<string>;
}

let open: OpenIncident | null = null;

function append(record: Record<string, unknown>): void {
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    appendFileSync(INCIDENT_LOG_PATH, `${JSON.stringify(record)}\n`, "utf8");
  } catch (e: any) {
    // Incident logging must never be the reason a request fails.
    console.error(`[incident] failed to append ${INCIDENT_LOG_PATH}: ${e?.message || e}`);
  }
}

function lastEventAt(incident: OpenIncident): number {
  const last = incident.events[incident.events.length - 1];
  return last ? Date.parse(last.at) : Date.parse(incident.opened_at);
}

/**
 * Record a failure against `lane`. A no-op for anything classifyIncident does not recognise -
 * that stays a single, isolated error exactly as it was logged before this module existed.
 *
 * The first qualifying failure opens a new incident. A later qualifying failure within
 * CORRELATION_WINDOW_MS of the last event attaches to that same incident (whether it repeats
 * the same lane/class or is a different one entirely); one further apart, or arriving once the
 * previous incident has already closed, starts a new incident instead.
 */
export function recordFailure(lane: string, message: string, cause?: unknown): void {
  const klass = classifyIncident(message, cause);
  if (!klass) return;

  const now = Date.now();
  if (open && now - lastEventAt(open) > CORRELATION_WINDOW_MS) open = null;

  if (!open) {
    open = { id: randomUUID(), opened_at: new Date().toISOString(), events: [], downLanes: new Set() };
    console.log(`[incident] ${open.id}: opened (${klass} on ${lane})`);
  }

  const event: IncidentEvent = { at: new Date().toISOString(), lane, kind: "failure", class: klass, message };
  open.events.push(event);
  open.downLanes.add(lane);
  append({ incident_id: open.id, ...event });
}

/**
 * Record that `lane` recovered. A no-op unless `lane` currently has an unresolved failure on
 * the open incident. Attaches a recovery event either way it applies, and once every lane
 * involved has recovered, closes the incident - the record itself stays on disk (this module
 * never rewrites or truncates the log), only the in-memory "still open" state clears so the
 * next qualifying failure starts a fresh incident rather than reopening this one.
 */
export function recordRecovery(lane: string, via?: string): void {
  if (!open || !open.downLanes.has(lane)) return;

  open.downLanes.delete(lane);
  const event: IncidentEvent = {
    at: new Date().toISOString(),
    lane,
    kind: "recovery",
    ...(via ? { message: via } : {}),
  };
  open.events.push(event);
  const closing = open.downLanes.size === 0;
  append({ incident_id: open.id, ...event, closed: closing });

  if (closing) {
    console.log(`[incident] ${open.id}: closed (all lanes recovered)`);
    open = null;
  }
}
