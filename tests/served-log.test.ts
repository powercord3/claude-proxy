import { describe, expect, it, vi } from "vitest";
import { appendFileSync } from "fs";

vi.mock("fs", () => ({ appendFileSync: vi.fn(), mkdirSync: vi.fn() }));

describe("served-log", () => {
  it("writes one JSON line with the resolved provider:model@effort", async () => {
    const { recordServed } = await import("../adapters/served-log.js");
    recordServed({
      requested: "sonnet", provider: "codex-oauth", model: "gpt-6", reasoning: "high",
      headers: { "x-claude-code-session-id": "s1" }, stream: true,
    });
    const line = JSON.parse(String((appendFileSync as any).mock.calls[0][1]));
    expect(line.resolved).toBe("codex-oauth:gpt-6@high");
    expect(line.requested).toBe("sonnet");
    expect(line.session_id).toBe("s1");
    expect(typeof line.request_id).toBe("string");
  });
  it("swallows write errors", async () => {
    (appendFileSync as any).mockImplementationOnce(() => { throw new Error("disk"); });
    const { recordServed } = await import("../adapters/served-log.js");
    expect(() => recordServed({ requested: "x", provider: "p", model: "m" })).not.toThrow();
  });
});
