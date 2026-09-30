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

describe("CompletionTap", () => {
  const ev = (type: string, o: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...o })}\n\n`;

  async function run(chunks: string[], times: number[]) {
    const { CompletionTap } = await import("../adapters/served-log.js");
    (appendFileSync as any).mockClear();
    let i = 0;
    const tap = new CompletionTap("req1", 1000, () => times[Math.min(i++, times.length - 1)]);
    for (const c of chunks) tap.feed(c);
    tap.finish(200, true);
    return JSON.parse(String((appendFileSync as any).mock.calls[0][1]));
  }

  it("streamed Anthropic reply: usage, cache breakdown, thinking estimate, timings; no text logged", async () => {
    const secret = "TOP-SECRET-PROMPT-ECHO";
    const sse =
      ev("message_start", { message: { usage: { input_tokens: 12, cache_read_input_tokens: 100, cache_creation_input_tokens: 50, cache_creation: { ephemeral_5m_input_tokens: 20, ephemeral_1h_input_tokens: 30 }, output_tokens: 1 } } }) +
      ev("content_block_delta", { delta: { type: "thinking_delta", thinking: "a".repeat(40) } }) +
      ev("content_block_delta", { delta: { type: "text_delta", text: secret } }) +
      ev("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 200 } });
    // split mid-line to prove the buffer joins chunks
    const cut = sse.indexOf("thinking_delta") + 5;
    // now() calls: feed#1, feed#2, then finish's end
    const line = await run([sse.slice(0, cut), sse.slice(cut)], [1100, 1300, 2000]);
    expect(line.kind).toBe("completion");
    expect(line.usage).toMatchObject({ input_tokens: 12, cache_read_input_tokens: 100, cache_creation_input_tokens: 50, ephemeral_5m_input_tokens: 20, ephemeral_1h_input_tokens: 30, output_tokens: 200 });
    expect(line.stop_reason).toBe("end_turn");
    expect(line.http_status).toBe(200);
    expect(line.reasoning_tokens).toBeNull();
    expect(line.reasoning_tokens_est).toBe(10);
    expect(line.reasoning_tokens_is_estimate).toBe(true);
    expect(line.time_to_first_token_ms).toBe(300);
    expect(line.total_ms).toBe(1000);
    expect(line.output_tokens_per_s).toBe(200 / 0.7 > 0 ? Math.round((200 / 0.7) * 100) / 100 : 0);
    expect(JSON.stringify(line)).not.toContain(secret);
  });

  it("codex lane: reported reasoning_tokens wins and is not flagged as an estimate", async () => {
    const sse =
      ev("message_start", { message: { usage: { input_tokens: 5, output_tokens: 0 } } }) +
      ev("content_block_delta", { delta: { type: "thinking_delta", thinking: "zzzz" } }) +
      ev("message_delta", { delta: { stop_reason: "tool_use" }, usage: { input_tokens: 5, output_tokens: 90, reasoning_tokens: 64, cache_read_input_tokens: 7 } });
    const line = await run([sse], [1050, 1100]);
    expect(line.reasoning_tokens).toBe(64);
    expect(line.reasoning_tokens_is_estimate).toBe(false);
    expect(line.reasoning_tokens_est).toBeNull();
    expect(line.usage.cache_read_input_tokens).toBe(7);
    expect(line.stop_reason).toBe("tool_use");
  });

  it("non-streamed JSON reply and error bodies do not throw", async () => {
    const body = JSON.stringify({ stop_reason: "end_turn", usage: { input_tokens: 3, output_tokens: 9 }, content: [{ type: "thinking", thinking: "x".repeat(8) }, { type: "text", text: "hi" }] });
    const line = await run([body], [1010]);
    expect(line.usage.output_tokens).toBe(9);
    expect(line.reasoning_tokens_est).toBe(2);
    const bad = await run(['{"error":"nope"}'], [1010]);
    expect(bad.usage.output_tokens).toBeNull();
  });
});
