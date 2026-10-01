import { describe, it, expect, vi } from "vitest";
import {
  toResponsesTools,
  toResponsesToolChoice,
  toResponsesInput,
  textFromResponsesMessageItem,
  normalizeMessagesForResponses,
  splitInputTokenUsage,
  isClaudeCompactionRequest,
  effectiveReasoningEffort,
  isCchNormalizeEnabled,
} from "../adapters/providers/codex-oauth.js";
import { parseProviderModel } from "../adapters/map.js";
import { conversationKey, threadIdFor } from "../adapters/codex-reasoning-cache.js";
import type { AnthropicMessage, AnthropicTool } from "../adapters/types.js";

describe("toResponsesTools", () => {
  it("converts Anthropic tools to Responses API function tools and appends web_search", () => {
    const tools: AnthropicTool[] = [
      {
        name: "Bash",
        description: "Run a shell command",
        input_schema: {
          type: "object",
          properties: { command: { type: "string" } },
          required: ["command"],
        },
      },
    ];
    const out = toResponsesTools(tools);
    expect(out).toEqual([
      {
        type: "function",
        name: "Bash",
        description: "Run a shell command",
        strict: false,
        parameters: {
          type: "object",
          properties: { command: { type: "string" } },
          required: ["command"],
        },
      },
      { type: "web_search" },
    ]);
  });

  it("provides a default empty parameters object when input_schema is missing", () => {
    const out = toResponsesTools([{ name: "NoSchema" }]);
    expect(out[0]).toMatchObject({
      type: "function",
      name: "NoSchema",
      parameters: { type: "object", properties: {} },
    });
  });

  it("returns just web_search when no tools provided", () => {
    expect(toResponsesTools(undefined)).toEqual([{ type: "web_search" }]);
  });
});

describe("toResponsesToolChoice", () => {
  it("maps Anthropic tool_choice to Responses API tool_choice", () => {
    expect(toResponsesToolChoice(undefined)).toBe("auto");
    expect(toResponsesToolChoice({ type: "auto" })).toBe("auto");
    expect(toResponsesToolChoice({ type: "any" })).toBe("required");
    expect(toResponsesToolChoice({ type: "none" })).toBe("none");
    expect(toResponsesToolChoice({ type: "tool", name: "Bash" })).toEqual({
      type: "function",
      name: "Bash",
    });
  });
});

describe("toResponsesInput", () => {
  it("converts a plain user message into an input_text message item", () => {
    const messages: AnthropicMessage[] = [{ role: "user", content: "hello" }];
    expect(toResponsesInput(messages)).toEqual([
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "hello" }],
      },
    ]);
  });

  it("converts assistant text to output_text", () => {
    const messages: AnthropicMessage[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello back" },
    ];
    const out = toResponsesInput(messages);
    expect(out[1]).toEqual({
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "hello back" }],
    });
  });

  it("emits tool_use as a top-level function_call item with the same call_id", () => {
    const messages: AnthropicMessage[] = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "Let me run that." },
          {
            type: "tool_use",
            id: "toolu_abc123",
            name: "Bash",
            input: { command: "ls" },
          },
        ],
      },
    ];
    const out = toResponsesInput(messages);
    expect(out).toEqual([
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "Let me run that." }],
      },
      {
        type: "function_call",
        call_id: "toolu_abc123",
        name: "Bash",
        arguments: '{"command":"ls"}',
      },
    ]);
  });

  it("emits tool_result as a top-level function_call_output keyed by tool_use_id", () => {
    const messages: AnthropicMessage[] = [
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_abc123",
            content: "total 24\ndrwxr-xr-x ...",
          },
        ],
      },
    ];
    const out = toResponsesInput(messages);
    expect(out).toEqual([
      {
        type: "function_call_output",
        call_id: "toolu_abc123",
        output: "total 24\ndrwxr-xr-x ...",
      },
    ]);
  });

  it("encodes a base64 image as input_image with a data URL", () => {
    const messages: AnthropicMessage[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "What's in this?" },
          {
            type: "image",
            source: { type: "base64", media_type: "image/png", data: "AAAA" },
          },
        ],
      },
    ];
    const out = toResponsesInput(messages);
    expect(out[0]).toEqual({
      type: "message",
      role: "user",
      content: [
        { type: "input_text", text: "What's in this?" },
        { type: "input_image", image_url: "data:image/png;base64,AAAA" },
      ],
    });
  });

  it("passes through a URL image as input_image with the original URL", () => {
    const messages: AnthropicMessage[] = [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: { type: "url", url: "https://example.com/x.png", media_type: "image/png" },
          },
        ],
      },
    ];
    const out = toResponsesInput(messages);
    expect(out[0]).toMatchObject({
      content: [{ type: "input_image", image_url: "https://example.com/x.png" }],
    });
  });

  it("drops replayed Anthropic thinking blocks instead of converting them to Codex reasoning", () => {
    const messages: AnthropicMessage[] = [
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "Let me consider...", signature: "sig" },
          { type: "text", text: "answer" },
        ],
      },
    ];
    const out = toResponsesInput(messages);
    expect(out).toEqual([
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "answer" }],
      },
    ]);
  });

  const injectedReasoning = [
    {
      type: "reasoning" as const,
      summary: [{ type: "summary_text" as const, text: "prev" }],
      encrypted_content: "enc_blob",
    },
  ];

  it("puts injected reasoning at the front when there is no assistant turn yet", () => {
    const messages: AnthropicMessage[] = [{ role: "user", content: "next turn" }];
    const out = toResponsesInput(messages, injectedReasoning);
    expect(out[0]).toEqual(injectedReasoning[0]);
    expect(out[1]).toEqual({
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "next turn" }],
    });
  });

  // These blobs are replaced with fresh server output every turn, so anything before them
  // must stay byte-identical across turns or the upstream prompt cache cannot match a prefix.
  // Putting them at out[0] left only `instructions`+`tools` cacheable and re-prefilled the
  // whole transcript on every tool call.
  it("splices injected reasoning before the last assistant turn, keeping the prefix stable", () => {
    const messages: AnthropicMessage[] = [
      { role: "user", content: "first" },
      { role: "assistant", content: "older answer" },
      { role: "user", content: "second" },
      { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "Read", input: { p: 1 } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "done" }] },
    ];
    const out = toResponsesInput(messages, injectedReasoning);

    // Everything up to the last assistant turn is untouched history -- the cacheable prefix.
    expect(out.slice(0, 3)).toEqual(toResponsesInput(messages.slice(0, 3)));

    // reasoning, then the function_call it produced, then that call's output.
    expect(out.slice(3)).toEqual([
      injectedReasoning[0],
      { type: "function_call", call_id: "toolu_1", name: "Read", arguments: JSON.stringify({ p: 1 }) },
      { type: "function_call_output", call_id: "toolu_1", output: "done" },
    ]);
  });

  it("does not move the splice onto the next turn for an assistant message that emits nothing", () => {
    const messages: AnthropicMessage[] = [
      { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "Read", input: {} }] },
      { role: "assistant", content: [{ type: "thinking", thinking: "dropped" }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "done" }] },
    ];
    const out = toResponsesInput(messages, injectedReasoning);
    expect(out[0]).toEqual(injectedReasoning[0]);
    expect(out[1]).toMatchObject({ type: "function_call", call_id: "toolu_1" });
    expect(out[2]).toMatchObject({ type: "function_call_output", call_id: "toolu_1" });
  });

  it("flattens structured tool_result content into a string", () => {
    const messages: AnthropicMessage[] = [
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_x",
            content: [
              { type: "text", text: "line 1" },
              { type: "text", text: "line 2" },
            ],
          },
        ],
      },
    ];
    const out = toResponsesInput(messages);
    expect(out[0]).toEqual({
      type: "function_call_output",
      call_id: "toolu_x",
      output: "line 1\nline 2",
    });
  });
});

describe("textFromResponsesMessageItem", () => {
  it("extracts output_text content from a completed Responses message item", () => {
    expect(
      textFromResponsesMessageItem({
        type: "message",
        content: [
          { type: "output_text", text: "hel" },
          { type: "output_text", text: "lo" },
        ],
      }),
    ).toBe("hello");
  });

  it("ignores non-message items", () => {
    expect(textFromResponsesMessageItem({ type: "reasoning", content: [] })).toBe("");
  });
});

describe("normalizeMessagesForResponses", () => {
  it("moves trailing developer context before the final user prompt", () => {
    const messages: AnthropicMessage[] = [
      { role: "user", content: "previous" },
      { role: "assistant", content: "ok" },
      { role: "user", content: "answer this" },
      { role: "system", content: "ambient MCP status" },
      { role: "developer", content: "skill listing" },
    ];

    expect(normalizeMessagesForResponses(messages).map((m) => m.content)).toEqual([
      "previous",
      "ok",
      "ambient MCP status",
      "skill listing",
      "answer this",
    ]);
  });

  it("leaves already-actionable tails untouched", () => {
    const messages: AnthropicMessage[] = [
      { role: "developer", content: "instructions" },
      { role: "user", content: "answer this" },
    ];

    expect(normalizeMessagesForResponses(messages)).toBe(messages);
  });
});

describe("splitInputTokenUsage", () => {
  it("converts OpenAI's overlapping cached count into additive Anthropic buckets", () => {
    const usage = splitInputTokenUsage(167_111, 166_528);

    expect(usage).toEqual({
      inputTokens: 583,
      cacheReadInputTokens: 166_528,
    });
    expect(usage.inputTokens + usage.cacheReadInputTokens).toBe(167_111);
  });

  it("clamps malformed cached counts so emitted usage stays non-negative", () => {
    expect(splitInputTokenUsage(100, 120)).toEqual({
      inputTokens: 0,
      cacheReadInputTokens: 100,
    });
  });
});

describe("Claude Code compaction detection", () => {
  const compactionPrompt = `CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.
Your task is to create a detailed summary of the conversation so far.`;

  it("caps generated compaction turns at medium reasoning", () => {
    const body: import("../adapters/types.js").AnthropicRequest = {
      model: "codex",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: compactionPrompt },
            { type: "tool_result", tool_use_id: "call_1", content: "done" },
          ],
        },
      ],
    };

    expect(isClaudeCompactionRequest(body)).toBe(true);
    expect(effectiveReasoningEffort(body, "xhigh")).toBe("medium");
    expect(effectiveReasoningEffort(body, "max")).toBe("medium");
    expect(effectiveReasoningEffort(body, "low")).toBe("low");
  });

  it("does not alter ordinary requests or generic summary requests", () => {
    const body: import("../adapters/types.js").AnthropicRequest = {
      model: "codex",
      messages: [
        { role: "user", content: compactionPrompt },
        { role: "assistant", content: "Previous summary." },
        { role: "user", content: "Please create a detailed summary of this file." },
      ],
    };

    expect(isClaudeCompactionRequest(body)).toBe(false);
    expect(effectiveReasoningEffort(body, "xhigh")).toBe("xhigh");
  });
});

describe("parseProviderModel — codex tier shortcuts", () => {
  it("expands codex to gpt-6-sol at High by default", () => {
    expect(parseProviderModel("codex")).toEqual({
      provider: "codex-oauth",
      model: "gpt-6-sol",
      reasoning: "high",
    });
  });

  it("expands the GPT-6/GPT-5.6 family shortcuts (Sol defaults to High)", () => {
    expect(parseProviderModel("sol")).toEqual({
      provider: "codex-oauth",
      model: "gpt-6-sol",
      reasoning: "high",
    });
    expect(parseProviderModel("terra")).toEqual({
      provider: "codex-oauth",
      model: "gpt-5.6-terra",
      reasoning: undefined,
    });
    expect(parseProviderModel("luna")).toEqual({
      provider: "codex-oauth",
      model: "gpt-6-luna",
      reasoning: undefined,
    });
    expect(parseProviderModel("gpt55")).toEqual({
      provider: "codex-oauth",
      model: "gpt-5.5",
      reasoning: undefined,
    });
  });

  it("expands tier shortcuts to gpt-6-sol plus a baked-in reasoning level", () => {
    expect(parseProviderModel("fast")).toEqual({
      provider: "codex-oauth",
      model: "gpt-6-sol",
      reasoning: "low",
    });
    expect(parseProviderModel("smart")).toEqual({
      provider: "codex-oauth",
      model: "gpt-6-sol",
      reasoning: "medium",
    });
    expect(parseProviderModel("deep")).toEqual({
      provider: "codex-oauth",
      model: "gpt-6-sol",
      reasoning: "high",
    });
    expect(parseProviderModel("xhigh")).toEqual({
      provider: "codex-oauth",
      model: "gpt-6-sol",
      reasoning: "xhigh",
    });
    expect(parseProviderModel("max")).toEqual({
      provider: "codex-oauth",
      model: "gpt-6-sol",
      reasoning: "max",
    });
    expect(parseProviderModel("think")).toEqual({
      provider: "codex-oauth",
      model: "gpt-6-sol",
      reasoning: "max",
    });
  });

  it("lets an explicit @level override the level baked into a shortcut", () => {
    expect(parseProviderModel("fast@xhigh")).toEqual({
      provider: "codex-oauth",
      model: "gpt-6-sol",
      reasoning: "xhigh",
    });
  });

  it("supports verbatim model@level syntax across the family", () => {
    expect(parseProviderModel("codex@xhigh")).toEqual({
      provider: "codex-oauth",
      model: "gpt-6-sol",
      reasoning: "xhigh",
    });
    expect(parseProviderModel("codex@low")).toEqual({
      provider: "codex-oauth",
      model: "gpt-6-sol",
      reasoning: "low",
    });
    expect(parseProviderModel("terra@max")).toEqual({
      provider: "codex-oauth",
      model: "gpt-5.6-terra",
      reasoning: "max",
    });
    expect(parseProviderModel("luna@high")).toEqual({
      provider: "codex-oauth",
      model: "gpt-6-luna",
      reasoning: "high",
    });
  });
});

describe("SSE aggregator", () => {
  it("collapses a streamed message into a non-streaming Anthropic Messages response", async () => {
    const { withAggregatedReply } = await import("../adapters/sse-aggregator.js");
    let captured = "";
    const fakeReply = {
      raw: {
        setHeader: () => {},
        end: (body: string) => {
          captured = body;
        },
      },
    } as unknown as import("fastify").FastifyReply;

    await withAggregatedReply(fakeReply, async (bufRes) => {
      const w = (event: string, data: unknown) => {
        bufRes.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      };
      w("message_start", {
        type: "message_start",
        message: {
          id: "msg_test",
          type: "message",
          role: "assistant",
          model: "gpt-5.5",
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 100, output_tokens: 0 },
        },
      });
      w("content_block_start", {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      });
      w("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "Hello" },
      });
      w("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: " world" },
      });
      w("content_block_stop", { type: "content_block_stop", index: 0 });
      w("message_delta", {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { input_tokens: 100, output_tokens: 2 },
      });
      w("message_stop", { type: "message_stop" });
      bufRes.raw.end();
    });

    const parsed = JSON.parse(captured);
    expect(parsed).toMatchObject({
      id: "msg_test",
      type: "message",
      role: "assistant",
      model: "gpt-5.5",
      content: [{ type: "text", text: "Hello world" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 100, output_tokens: 2 },
    });
  });

  it("aggregates a tool_use block from streamed input_json_delta chunks", async () => {
    const { withAggregatedReply } = await import("../adapters/sse-aggregator.js");
    let captured = "";
    const fakeReply = {
      raw: { setHeader: () => {}, end: (b: string) => { captured = b; } },
    } as unknown as import("fastify").FastifyReply;

    await withAggregatedReply(fakeReply, async (bufRes) => {
      const w = (event: string, data: unknown) => {
        bufRes.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      };
      w("message_start", {
        type: "message_start",
        message: {
          id: "msg_x",
          type: "message",
          role: "assistant",
          model: "gpt-5.5",
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      });
      w("content_block_start", {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "toolu_1", name: "Bash", input: {} },
      });
      w("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: '{"cmd":' },
      });
      w("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: '"ls"}' },
      });
      w("content_block_stop", { type: "content_block_stop", index: 0 });
      w("message_delta", {
        type: "message_delta",
        delta: { stop_reason: "tool_use", stop_sequence: null },
        usage: { input_tokens: 5, output_tokens: 3 },
      });
      bufRes.raw.end();
    });

    const parsed = JSON.parse(captured);
    expect(parsed.content[0]).toEqual({
      type: "tool_use",
      id: "toolu_1",
      name: "Bash",
      input: { cmd: "ls" },
    });
    expect(parsed.stop_reason).toBe("tool_use");
  });
});

describe("conversationKey + threadIdFor", () => {
  it("returns the same key for the same first user turn", () => {
    const a = conversationKey([{ role: "user", content: "hello world" }]);
    const b = conversationKey([
      { role: "user", content: "hello world" },
      { role: "assistant", content: "hi" },
      { role: "user", content: "different follow-up" },
    ]);
    expect(a).toBe(b);
  });

  it("returns different keys for different first user turns", () => {
    const a = conversationKey([{ role: "user", content: "alpha" }]);
    const b = conversationKey([{ role: "user", content: "beta" }]);
    expect(a).not.toBe(b);
  });

  it("produces a UUID-shaped thread ID from a key", () => {
    const k = conversationKey([{ role: "user", content: "x" }]);
    const t = threadIdFor(k);
    expect(t).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });
});

describe("B1 default flip — CCX_PROMPT_CACHE_KEY_V2 (work order item 2)", () => {
  // Full-request integration test: proves the env flag actually changes what codex-oauth.ts
  // puts on the wire, not just that the two pure key functions differ (see prompt-cache.test.ts
  // for the pure-function-level B1 coverage). A reminder longer than the legacy 4096-char slice
  // reproduces the exact collision from work order section 4.
  //
  // UPDATED for item 2: promoted to DEFAULT-ON 2026-09-05 on the strength of an isolated
  // 86-request trace where firstUserStrippedHash was identical on 86/86 requests, including a
  // genuine ordinary follow-up user turn. This inverts the old default -- the assertions below
  // are deliberately the mirror image of the pre-flip version of this test.
  it("defaults to the split (v2) key and only collides again once explicitly disabled", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { chatCodexOAuth } = await import("../adapters/providers/codex-oauth.js");
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      body: new ReadableStream({ start(c) { c.close(); } }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const reminder = `<system-reminder>${"x".repeat(5000)}</system-reminder>`;
    const bodyFor = (tail: string) =>
      ({
        model: "codex",
        messages: [{ role: "user", content: `${reminder}\n${tail}` }],
      }) as unknown as import("../adapters/types.js").AnthropicRequest;
    const fakeReply = {
      raw: { write: () => {}, end: () => {}, writableEnded: false },
    } as unknown as import("fastify").FastifyReply;
    const sentKeyOf = (call: number) =>
      JSON.parse((fetchMock.mock.calls[call][1] as RequestInit).body as string).prompt_cache_key;
    // Both the legacy and v2 candidates must stay computed and logged in EVERY case, regardless
    // of which one the gate selects (work order item 2: "Keep computing and logging BOTH ...
    // exactly as now").
    const correlateLines = () =>
      log.mock.calls.map((c) => c[0]).filter((l): l is string => typeof l === "string" && l.includes("[codex] p0-correlate"));

    // Capture whatever this var was already set to (a dev/CI shell may export it) rather than
    // unconditionally clearing it, so this test cannot leave a real ambient value clobbered for
    // whatever runs after it -- mirrors the ORIGINAL-capture pattern in prompt-cache.test.ts.
    const ORIGINAL_V2 = process.env.CCX_PROMPT_CACHE_KEY_V2;
    try {
      delete process.env.CCX_PROMPT_CACHE_KEY_V2;
      await chatCodexOAuth(fakeReply, bodyFor("conversation A"), "gpt-5.6-sol", "test-key");
      await chatCodexOAuth(fakeReply, bodyFor("conversation B"), "gpt-5.6-sol", "test-key");
      // NEW default: this would have FAILED against the pre-item-2 code, which read
      // `CCX_PROMPT_CACHE_KEY_V2 === "1"` and so still defaulted to the legacy, colliding key
      // with the env var unset.
      expect(sentKeyOf(0)).not.toBe(sentKeyOf(1));

      process.env.CCX_PROMPT_CACHE_KEY_V2 = "0";
      await chatCodexOAuth(fakeReply, bodyFor("conversation A"), "gpt-5.6-sol", "test-key");
      await chatCodexOAuth(fakeReply, bodyFor("conversation B"), "gpt-5.6-sol", "test-key");
      // Explicit opt-out restores the legacy (colliding) key -- this documents the pre-existing
      // bug the flag now guards against BY DEFAULT, not the fix, mirroring what the old
      // "canary off" case documented before the flip.
      expect(sentKeyOf(2)).toBe(sentKeyOf(3));
    } finally {
      if (ORIGINAL_V2 === undefined) delete process.env.CCX_PROMPT_CACHE_KEY_V2;
      else process.env.CCX_PROMPT_CACHE_KEY_V2 = ORIGINAL_V2;
    }

    const lines = correlateLines();
    expect(lines.length).toBe(4);
    for (const line of lines) {
      expect(line).toMatch(/legacyKey=[0-9a-f]{8}/);
      expect(line).toMatch(/v2Candidate=[0-9a-f]{8}/);
    }

    log.mockRestore();
    vi.unstubAllGlobals();
  });
});

describe("isCchNormalizeEnabled (Fix A default flip, 2026-09-06)", () => {
  // Save/restore rather than unconditional delete, so a real ambient CCX_NORMALIZE_CCH (dev
  // or CI shell) is restored instead of clobbered -- same discipline as ORIGINAL_V2 and
  // ORIGINAL_NORMALIZE elsewhere in this file.
  const ORIGINAL = process.env.CCX_NORMALIZE_CCH;

  it("defaults to enabled (true) when the env var is unset -- the NEW default", () => {
    // Before this flip, cchNormalizedForWire read `!== "1"` only, defaulting OFF. This
    // assertion would have FAILED against that code with the env var unset (it would have
    // returned false).
    try {
      delete process.env.CCX_NORMALIZE_CCH;
      expect(isCchNormalizeEnabled()).toBe(true);
    } finally {
      if (ORIGINAL === undefined) delete process.env.CCX_NORMALIZE_CCH;
      else process.env.CCX_NORMALIZE_CCH = ORIGINAL;
    }
  });

  it.each(["0", "false", "off", "FALSE", "OFF"])("treats %s as an explicit opt-out", (value) => {
    try {
      process.env.CCX_NORMALIZE_CCH = value;
      expect(isCchNormalizeEnabled()).toBe(false);
    } finally {
      if (ORIGINAL === undefined) delete process.env.CCX_NORMALIZE_CCH;
      else process.env.CCX_NORMALIZE_CCH = ORIGINAL;
    }
  });

  it("treats \"1\", the old canary spelling, and any other value as enabled", () => {
    try {
      process.env.CCX_NORMALIZE_CCH = "1";
      expect(isCchNormalizeEnabled()).toBe(true);
      process.env.CCX_NORMALIZE_CCH = "yes";
      expect(isCchNormalizeEnabled()).toBe(true);
    } finally {
      if (ORIGINAL === undefined) delete process.env.CCX_NORMALIZE_CCH;
      else process.env.CCX_NORMALIZE_CCH = ORIGINAL;
    }
  });
});

describe("Fix A wiring — CCX_NORMALIZE_CCH (work order section 6)", () => {
  // Full-request integration test, modeled on the B1 test above: proves the normalizer is
  // actually WIRED into chatCodexOAuth's outgoing `instructions` and into the p0-correlate log's
  // rawInstrHash/sentInstrHash/cchNormalized fields -- not just that normalizeCchForWire and
  // cchNormalizedForWire behave correctly in isolation (see prompt-cache.test.ts for that
  // pure-function-level coverage). Before this test, grepping tests/codex-oauth.test.ts for
  // CCX_NORMALIZE_CCH found nothing: a wiring regression (e.g. reqBody.instructions accidentally
  // sent the raw string, or rawInstrHash accidentally hashing the normalized one instead of what
  // Claude Code actually sent) would fail silently -- p0-correlate would keep emitting confident,
  // wrong numbers with nothing here to catch it.
  //
  // UPDATED 2026-09-06: promoted to DEFAULT-ON on the strength of the ad-hoc-enabled measurement
  // (see cchNormalizedForWire's doc comment for the full trace: 142,976-token cache reads with
  // CCX_NORMALIZE_CCH=1 set versus a cacheRead that never exceeded 5,760 across the 400 requests
  // before it was enabled, with no launcher ever setting the variable). This inverts the old
  // default -- the assertions below are deliberately the mirror image of the pre-flip version of
  // this test, mirroring the CCX_PROMPT_CACHE_KEY_V2 flip above.
  it("normalizes what actually goes on the wire while rawInstrHash keeps tracking Claude Code's real cch churn", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { chatCodexOAuth } = await import("../adapters/providers/codex-oauth.js");
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      body: new ReadableStream({ start(c) { c.close(); } }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    // A recognized Claude Code metadata line (cc_version=...+cc_prompt_id=...) with only the
    // `cch=` field varying between requests -- the same shape normalizeCchForWire's own unit
    // tests use, driven here through the actual request path instead of called directly.
    const promptId = "550e8400-e29b-41d4-a716-446655440000";
    const metadataLine = (cch: string) =>
      `env: cc_version=2.1.261.2ad; cc_entrypoint=claude-vscode; cch=${cch}; cc_is_subagent=true; cc_prompt_id=${promptId};`;
    const systemTail = "You are Claude Code, Anthropic's official CLI for Claude.";
    const bodyFor = (cch: string, tail: string) =>
      ({
        model: "codex",
        system: `${metadataLine(cch)}\n${systemTail}`,
        messages: [{ role: "user", content: tail }],
      }) as unknown as import("../adapters/types.js").AnthropicRequest;
    const fakeReply = {
      raw: { write: () => {}, end: () => {}, writableEnded: false },
    } as unknown as import("fastify").FastifyReply;

    const sentInstructionsOf = (call: number) =>
      JSON.parse((fetchMock.mock.calls[call][1] as RequestInit).body as string).instructions as string;
    const correlateLines = () =>
      log.mock.calls.map((c) => c[0]).filter((l): l is string => typeof l === "string" && l.includes("[codex] p0-correlate"));
    const fieldsOf = (line: string) => ({
      raw: /rawInstrHash=([0-9a-f]{12})/.exec(line)?.[1],
      sent: /sentInstrHash=([0-9a-f]{12})/.exec(line)?.[1],
      normalized: /cchNormalized=(true|false)/.exec(line)?.[1],
    });

    // Save/restore rather than unconditional delete, so a real ambient CCX_NORMALIZE_CCH (dev
    // or CI shell) is restored instead of clobbered -- same discipline as ORIGINAL_V2 above and
    // the ORIGINAL pattern in prompt-cache.test.ts.
    const ORIGINAL_NORMALIZE = process.env.CCX_NORMALIZE_CCH;
    try {
      delete process.env.CCX_NORMALIZE_CCH;
      await chatCodexOAuth(fakeReply, bodyFor("3ad2c", "conversation turn 1"), "gpt-5.6-sol", "test-key");
      await chatCodexOAuth(fakeReply, bodyFor("99999", "conversation turn 2"), "gpt-5.6-sol", "test-key");

      const [line0, line1] = correlateLines();
      const f0 = fieldsOf(line0);
      const f1 = fieldsOf(line1);
      // NEW default: this would have FAILED against the pre-2026-09-06 code, which read
      // `CCX_NORMALIZE_CCH !== "1"` and so still defaulted to unnormalized, per-request-varying
      // instructions with the env var unset. The experiment this test exists to run: raw varies
      // (Claude Code's cch churn stays visible) while sent stays put (the wire is stable). A test
      // that only checked "some normalization happened" would still pass if raw and sent
      // accidentally hashed the same string -- this raw-varies/sent-holds pair is what rules that
      // out.
      expect(f0.raw).toBeTruthy();
      expect(f0.raw).not.toBe(f1.raw);
      expect(f0.sent).toBeTruthy();
      expect(f0.sent).toBe(f1.sent);
      expect(f0.normalized).toBe("true");
      expect(f1.normalized).toBe("true");
      // What actually reached the wire carries the fixed constant, not either original cch --
      // this is the assertion a wiring bug (normalizer computed but never plugged into
      // reqBody.instructions) would fail even though the pure-function tests all pass.
      expect(sentInstructionsOf(0)).toContain("cch=00000");
      expect(sentInstructionsOf(0)).not.toContain("cch=3ad2c");
      expect(sentInstructionsOf(1)).toContain("cch=00000");
      expect(sentInstructionsOf(1)).not.toContain("cch=99999");

      process.env.CCX_NORMALIZE_CCH = "0";
      await chatCodexOAuth(fakeReply, bodyFor("abcde", "conversation turn 3"), "gpt-5.6-sol", "test-key");
      const line2 = correlateLines()[2];
      const f2 = fieldsOf(line2);
      // Explicit opt-out restores the pre-fix, per-request-varying wire -- this documents the
      // reverted behaviour the flag now guards against BY DEFAULT, not the fix, mirroring what
      // the old "flag unset" case documented before the flip.
      expect(f2.normalized).toBe("false");
      expect(f2.sent).toBeTruthy();
      expect(f2.sent).toBe(f2.raw);
      expect(sentInstructionsOf(2)).toContain("cch=abcde");
    } finally {
      if (ORIGINAL_NORMALIZE === undefined) delete process.env.CCX_NORMALIZE_CCH;
      else process.env.CCX_NORMALIZE_CCH = ORIGINAL_NORMALIZE;
    }

    log.mockRestore();
    vi.unstubAllGlobals();
  });
});
