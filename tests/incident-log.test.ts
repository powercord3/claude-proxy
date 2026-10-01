import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appendFileSync, mkdirSync } from "fs";

/**
 * Coverage for adapters/incident-log.ts (finding #436's "small honest slice": correlate the
 * gateway's own simultaneous failures into one durable record).
 *
 * incident-log.ts keeps its "currently open incident" as module-level state (its own `let
 * open`), so each test needs a fresh module instance rather than fighting that state between
 * cases - same dynamic-import-after-vi.resetModules() pattern as
 * mesh-observability.test.ts's loadReasoningCache. Real disk writes are mocked out: this suite
 * exercises the state machine directly, without touching ~/.claude-proxy/incidents.jsonl and
 * without spawning the gateway process at all.
 */
vi.mock("fs", () => ({
  appendFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

async function loadIncidentLog() {
  vi.resetModules();
  return import("../adapters/incident-log.js");
}

function appended(): Record<string, any>[] {
  return (appendFileSync as unknown as ReturnType<typeof vi.fn>).mock.calls.map(([, line]) =>
    JSON.parse(String(line).trim())
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-13T12:00:00Z"));
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  (appendFileSync as unknown as ReturnType<typeof vi.fn>).mockClear();
  (mkdirSync as unknown as ReturnType<typeof vi.fn>).mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("classifyIncident", () => {
  it("classifies a thrown fetch() rejection by its cause.code", async () => {
    const { classifyIncident } = await loadIncidentLog();
    expect(classifyIncident("fetch failed", { code: "ECONNREFUSED" })).toBe("transport-refusal");
  });

  it("classifies a bare 'fetch failed' message with no cause", async () => {
    const { classifyIncident } = await loadIncidentLog();
    expect(classifyIncident("fetch failed")).toBe("transport-refusal");
  });

  it("classifies Anthropic's own permission_error type as a policy denial", async () => {
    // anthropic-pass.ts forwards the upstream body verbatim into the thrown message
    // (anthropic-pass.ts:257-262), so a real denial carries Anthropic's documented
    // `"type":"permission_error"` field - matched on that structured field, not a guessed
    // English sentence (see the regression case just below).
    const { classifyIncident } = await loadIncidentLog();
    const msg =
      'Upstream error (403): {"type":"error","error":{"type":"permission_error","message":"Your organization has disabled Claude access."}}';
    expect(classifyIncident(msg)).toBe("policy-denial");
  });

  it("does NOT classify a locally-thrown 401 (no API key configured) as a policy denial", async () => {
    // Regression for the reviewer finding on #436: 401/403 alone is not a policy-denial signal.
    // The gateway throws its own 401 when no credentials are configured at all
    // (anthropic-gateway.ts:605-610) - that's a local config problem, not an org denying access,
    // and must not be misclassified as one just because the status code matches.
    const { classifyIncident } = await loadIncidentLog();
    const msg =
      "No Anthropic credentials. Either sign in to Claude Code (its Authorization header is forwarded) or set ANTHROPIC_API_KEY in ~/.claude-proxy/.env";
    expect(classifyIncident(msg)).toBeNull();
  });

  it("returns null for an ordinary upstream error", async () => {
    const { classifyIncident } = await loadIncidentLog();
    expect(classifyIncident('Upstream error (400): "bad request"')).toBeNull();
  });
});

describe("recordFailure / recordRecovery state machine", () => {
  it("a non-qualifying failure never opens an incident", async () => {
    const { recordFailure } = await loadIncidentLog();
    recordFailure("anthropic", 'Upstream error (400): "bad request"');
    expect(appendFileSync).not.toHaveBeenCalled();
  });

  it("two simultaneous refusals across lanes correlate into one incident id, closed once both recover", async () => {
    // Acceptance criterion from the brief: a fixture emitting two simultaneous refusals then
    // recovery yields one incident id containing both plus the recovery.
    const { recordFailure, recordRecovery } = await loadIncidentLog();

    recordFailure("anthropic", "fetch failed", { code: "ECONNREFUSED" });
    vi.advanceTimersByTime(1000);
    recordFailure("openrouter", "fetch failed", { code: "ECONNREFUSED" });
    vi.advanceTimersByTime(1000);
    recordRecovery("anthropic");
    vi.advanceTimersByTime(1000);
    recordRecovery("openrouter");

    const events = appended();
    expect(events).toHaveLength(4);
    expect(new Set(events.map((e) => e.incident_id)).size).toBe(1);
    expect(events.map((e) => e.kind)).toEqual(["failure", "failure", "recovery", "recovery"]);
    expect(events.map((e) => e.lane)).toEqual(["anthropic", "openrouter", "anthropic", "openrouter"]);
    expect(events[2].closed).toBe(false); // openrouter still down - incident stays open
    expect(events[3].closed).toBe(true); // last down lane recovered - incident closes
  });

  it("a failure past the correlation window starts a new incident rather than reopening the old one", async () => {
    const { recordFailure } = await loadIncidentLog();

    recordFailure("anthropic", "fetch failed", { code: "ECONNREFUSED" });
    vi.advanceTimersByTime(3 * 60 * 1000); // past the 2-minute correlation window
    recordFailure("anthropic", "fetch failed", { code: "ECONNREFUSED" });

    const events = appended();
    expect(events).toHaveLength(2);
    expect(events[0].incident_id).not.toBe(events[1].incident_id);
  });

  it("a recovery on a lane with no open failure is a no-op", async () => {
    const { recordRecovery } = await loadIncidentLog();
    recordRecovery("anthropic");
    expect(appendFileSync).not.toHaveBeenCalled();
  });
});
