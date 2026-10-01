import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

/**
 * Two contracts the E2E suite (fallback-e2e.test.ts) cannot reach cheaply:
 *   - codex's usage_limit_reached body -> provider-health.json `resets_at` (the codex base URL
 *     is fixed to chatgpt.com, so a live 429 cannot be staged against a second gateway);
 *   - the probe schedule (nextProbeAt), whose failure modes are hours long.
 * provider-health.ts resolves its file path from homedir() at import, so USERPROFILE/HOME are
 * pointed at a temp dir before the dynamic import - the live ~/.claude-proxy is never written.
 */
const home = mkdtempSync(join(tmpdir(), "ccx-health-"));
const saved = { USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME };

beforeAll(() => {
  process.env.USERPROFILE = home;
  process.env.HOME = home;
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterAll(() => {
  process.env.USERPROFILE = saved.USERPROFILE;
  process.env.HOME = saved.HOME;
  vi.restoreAllMocks();
});

const QUOTA_BODY =
  '{"error":{"type":"usage_limit_reached","message":"The usage limit has been reached","plan_type":"plus","resets_at":1789366062,"eligible_promo":null,"resets_in_seconds":9510}}';

describe("codex quota resets_at", () => {
  it("parses resets_at (unix seconds) from the real usage_limit_reached body", async () => {
    const { parseCodexResetsAt } = await import("../adapters/providers/codex-oauth.js");
    expect(parseCodexResetsAt(QUOTA_BODY)?.toISOString()).toBe(new Date(1789366062 * 1000).toISOString());
    expect(parseCodexResetsAt("<html>nope</html>")).toBeUndefined();
  });

  it("markLaneDown stores it as an ISO string and laneBelievedDown honours it", async () => {
    vi.resetModules();
    const health = await import("../adapters/provider-health.js");
    const resetsAt = new Date(1789366062 * 1000);
    health.markLaneDown("codex-oauth", "codex-quota", QUOTA_BODY, resetsAt);
    const onDisk = JSON.parse(readFileSync(join(home, ".claude-proxy", "provider-health.json"), "utf8"));
    expect(onDisk["codex-oauth"]).toMatchObject({ status: "down", reason: "codex-quota", resets_at: resetsAt.toISOString() });
    expect(health.laneBelievedDown("codex-oauth", resetsAt.getTime() - 1)).toBe(true);
    expect(health.laneBelievedDown("codex-oauth", resetsAt.getTime() + 1)).toBe(false);
    // A repeat of the same outage with a later reset moves the stored time forward.
    const later = new Date(resetsAt.getTime() + 3_600_000);
    health.markLaneDown("codex-oauth", "codex-quota", QUOTA_BODY, later);
    expect(health.laneHealth("codex-oauth")?.resets_at).toBe(later.toISOString());
  });
});

describe("nextProbeAt", () => {
  const rec = (resets_at?: string) => ({ status: "down" as const, reason: "x", detected_at: "2026-09-20T00:00:00Z", last_error_snippet: "", ...(resets_at ? { resets_at } : {}) });
  const start = Date.parse("2026-09-23T10:00:00Z");
  const MIN = 60_000;

  it("known reset: first probe at resets_at + 60s, then every 15 min", async () => {
    const { nextProbeAt } = await import("../adapters/lane-probe.js");
    const r = rec("2026-09-23T12:00:00Z");
    const reset = Date.parse("2026-09-23T12:00:00Z");
    expect(nextProbeAt("codex-oauth", r, undefined, start)).toBe(reset + MIN);
    expect(nextProbeAt("codex-oauth", r, reset + MIN, start)).toBe(reset + 16 * MIN);
  });

  it("unknown reset: every 15 min from start or last probe", async () => {
    const { nextProbeAt } = await import("../adapters/lane-probe.js");
    expect(nextProbeAt("openrouter", rec(), undefined, start)).toBe(start + 15 * MIN);
    expect(nextProbeAt("openrouter", rec(), start + 20 * MIN, start)).toBe(start + 35 * MIN);
  });

  it("deepseek is never probed more often than hourly, even with a reset time", async () => {
    const { nextProbeAt } = await import("../adapters/lane-probe.js");
    expect(nextProbeAt("deepseek", rec(), undefined, start)).toBe(start + 60 * MIN);
    const last = start + 5 * MIN;
    expect(nextProbeAt("deepseek", rec("2026-09-23T10:06:00Z"), last, start)).toBe(last + 60 * MIN);
  });
});
