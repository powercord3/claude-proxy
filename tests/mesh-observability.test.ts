import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AnthropicRequest, AnthropicTool } from "../adapters/types.js";

const item = {
  type: "reasoning" as const,
  summary: [{ type: "summary_text" as const, text: "prior reasoning" }],
  encrypted_content: "encrypted",
};

async function loadReasoningCache(ttl?: string, cacheMax?: string) {
  vi.resetModules();
  if (ttl === undefined) delete process.env.CCX_REASONING_TTL_MS;
  else process.env.CCX_REASONING_TTL_MS = ttl;
  if (cacheMax === undefined) delete process.env.CCX_REASONING_CACHE_MAX;
  else process.env.CCX_REASONING_CACHE_MAX = cacheMax;
  return import("../adapters/codex-reasoning-cache.js");
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-09T12:00:00Z"));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  delete process.env.CCX_REASONING_TTL_MS;
  delete process.env.CCX_REASONING_CACHE_MAX;
});

describe("reasoning cache observability", () => {
  it("keeps a first-sighting miss silent", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { reasoningItemsByKey } = await loadReasoningCache();

    expect(reasoningItemsByKey("first-sighting-key")).toEqual([]);
    expect(log).not.toHaveBeenCalled();
  });

  it("logs one lapse after prior activity and stays silent on repeated misses", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { reasoningItemsByKey, setReasoningItemsByKey } = await loadReasoningCache("60000");
    const key = "12345678-lapsed";
    setReasoningItemsByKey(key, [item]);
    vi.advanceTimersByTime(60_001);

    expect(reasoningItemsByKey(key)).toEqual([]);
    expect(reasoningItemsByKey(key)).toEqual([]);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(
      "[codex] reasoning-cache LAPSED: key=12345678 idle=1m items=1 - continuing with full text history and no reasoning state",
    );
  });

  it("logs EVICTED, not LAPSED, when the cache cap dropped a live entry", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { reasoningItemsByKey, setReasoningItemsByKey } = await loadReasoningCache("60000");
    const key = "evicted-key";
    setReasoningItemsByKey(key, [item]);
    for (let i = 0; i < 300; i++) setReasoningItemsByKey(`filler-${i}`, [item]);

    expect(reasoningItemsByKey(key)).toEqual([]);
    expect(log).toHaveBeenCalledWith(
      "[codex] reasoning-cache EVICTED: key=evicted- idle=0m items=1 - dropped by the 256-entry cache cap, not by the TTL; raise CCX_REASONING_CACHE_MAX if this recurs",
    );
    expect(log.mock.calls.some(([line]) => String(line).includes("LAPSED"))).toBe(false);
  });

  it("still logs LAPSED, not EVICTED, for a genuine post-TTL miss", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { reasoningItemsByKey, setReasoningItemsByKey } = await loadReasoningCache("60000");
    const key = "genuine-lapse";
    setReasoningItemsByKey(key, [item]);
    vi.advanceTimersByTime(60_001);

    expect(reasoningItemsByKey(key)).toEqual([]);
    expect(log).toHaveBeenCalledWith(
      "[codex] reasoning-cache LAPSED: key=genuine- idle=1m items=1 - continuing with full text history and no reasoning state",
    );
    expect(log.mock.calls.some(([line]) => String(line).includes("EVICTED"))).toBe(false);
  });

  it("honours CCX_REASONING_CACHE_MAX", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { reasoningItemsByKey, setReasoningItemsByKey } = await loadReasoningCache("60000", "2");
    const key = "small-cap";
    setReasoningItemsByKey(key, [item]);
    setReasoningItemsByKey("filler-a", [item]);
    setReasoningItemsByKey("filler-b", [item]);

    expect(reasoningItemsByKey(key)).toEqual([]);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("2-entry cache cap"));
  });

  it("falls back to the 256-entry default for a garbage CCX_REASONING_CACHE_MAX", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { reasoningItemsByKey, setReasoningItemsByKey } = await loadReasoningCache("60000", "garbage");
    const key = "garbage-cap";
    setReasoningItemsByKey(key, [item]);
    for (let i = 0; i < 256; i++) setReasoningItemsByKey(`filler-${i}`, [item]);

    expect(reasoningItemsByKey(key)).toEqual([]);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("256-entry cache cap"));
  });

  it("falls back to the 256-entry default for a non-positive CCX_REASONING_CACHE_MAX", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { reasoningItemsByKey, setReasoningItemsByKey } = await loadReasoningCache("60000", "0");
    const key = "zero-cap";
    setReasoningItemsByKey(key, [item]);
    for (let i = 0; i < 256; i++) setReasoningItemsByKey(`filler-${i}`, [item]);

    expect(reasoningItemsByKey(key)).toEqual([]);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("256-entry cache cap"));
  });

  it("re-arms the lapse detector after new reasoning activity", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { reasoningItemsByKey, setReasoningItemsByKey } = await loadReasoningCache("60000");
    const key = "87654321-rearmed";
    setReasoningItemsByKey(key, [item]);
    vi.advanceTimersByTime(60_001);
    reasoningItemsByKey(key);
    setReasoningItemsByKey(key, [item]);
    vi.advanceTimersByTime(60_001);
    reasoningItemsByKey(key);

    expect(log.mock.calls.filter(([line]) => String(line).includes("LAPSED"))).toHaveLength(2);
  });

  it("honours CCX_REASONING_TTL_MS", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { reasoningItemsByKey, setReasoningItemsByKey } = await loadReasoningCache("10000");
    setReasoningItemsByKey("custom-ttl", [item]);
    vi.advanceTimersByTime(10_001);

    expect(reasoningItemsByKey("custom-ttl")).toEqual([]);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("reasoning-cache LAPSED"));
  });

  it("falls back to four hours for a garbage TTL value", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { reasoningItemsByKey, setReasoningItemsByKey } = await loadReasoningCache("garbage");
    setReasoningItemsByKey("fallback-ttl", [item]);
    vi.advanceTimersByTime(4 * 60 * 60 * 1000 - 1);

    expect(reasoningItemsByKey("fallback-ttl")).toEqual([item]);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("reasoning-cache RESCUED"));
  });

  it("logs RESCUED after more than 30 minutes idle", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { reasoningItemsByKey, setReasoningItemsByKey } = await loadReasoningCache();
    setReasoningItemsByKey("rescue12-key", [item]);
    vi.advanceTimersByTime(31 * 60 * 1000);

    expect(reasoningItemsByKey("rescue12-key")).toEqual([item]);
    expect(log).toHaveBeenCalledWith(
      "[codex] reasoning-cache RESCUED: key=rescue12 idle=31m - would have lapsed under the old 30m TTL",
    );
  });

  it("does not log RESCUED after five minutes idle", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { reasoningItemsByKey, setReasoningItemsByKey } = await loadReasoningCache();
    setReasoningItemsByKey("short-idle", [item]);
    vi.advanceTimersByTime(5 * 60 * 1000);

    expect(reasoningItemsByKey("short-idle")).toEqual([item]);
    expect(log).not.toHaveBeenCalled();
  });
});

describe("Codex tool schema observability", () => {
  it("flags $ref and anyOf and returns empty for a flat schema", async () => {
    const { inspectToolSchema } = await import("../adapters/providers/codex-oauth.js");
    expect(inspectToolSchema({ anyOf: [{ $ref: "#/$defs/x" }] }).constructs).toEqual(["$ref", "anyOf"]);
    expect(inspectToolSchema({ type: "object", properties: { value: { type: "string" } } }).constructs).toEqual([]);
  });

  it("terminates on cyclic schema objects", async () => {
    const { inspectToolSchema } = await import("../adapters/providers/codex-oauth.js");
    const cyclic: Record<string, unknown> = { type: "object" };
    cyclic.self = cyclic;
    expect(inspectToolSchema(cyclic)).toEqual({ constructs: [], maxDepth: 1 });
  });

  it("warns only once per tool name", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { toResponsesTools } = await import("../adapters/providers/codex-oauth.js");
    const tool = { name: "ExoticOnce", input_schema: { anyOf: [{ type: "string" }] } } as AnthropicTool;
    toResponsesTools([tool]);
    toResponsesTools([tool]);

    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(
      "[codex] tool schema note: ExoticOnce uses anyOf (depth 2) - malformed-args retries on this tool may be schema-caused, not model slippage",
    );
  });

  it("returns byte-identical tool objects with and without the schema note firing", async () => {
    const { toResponsesTools } = await import("../adapters/providers/codex-oauth.js");
    const tool = { name: "ByteIdentical", input_schema: { anyOf: [{ type: "string" }] } } as AnthropicTool;
    const withNote = JSON.stringify(toResponsesTools([tool]));
    const afterAlreadyWarned = JSON.stringify(toResponsesTools([tool]));

    expect(afterAlreadyWarned).toBe(withNote);
  });

  it("walks each tool schema only once across repeated toResponsesTools calls", async () => {
    const { toResponsesTools } = await import("../adapters/providers/codex-oauth.js");
    let reads = 0;
    const schema: Record<string, unknown> = { type: "object" };
    Object.defineProperty(schema, "probe", {
      enumerable: true,
      get() {
        reads += 1;
        return { type: "string" };
      },
    });
    const tool = { name: "WalkedOnce", input_schema: schema } as unknown as AnthropicTool;
    toResponsesTools([tool]);
    toResponsesTools([tool]);

    expect(reads).toBe(1);
  });

  it("walks a clean schema exactly once too (no findings still records the inspection)", async () => {
    const { toResponsesTools } = await import("../adapters/providers/codex-oauth.js");
    let reads = 0;
    const schema: Record<string, unknown> = { type: "object" };
    Object.defineProperty(schema, "probe", {
      enumerable: true,
      get() {
        reads += 1;
        return { type: "string" };
      },
    });
    const tool = { name: "CleanWalkedOnce", input_schema: schema } as unknown as AnthropicTool;
    toResponsesTools([tool]);
    toResponsesTools([tool]);
    toResponsesTools([tool]);

    expect(reads).toBe(1);
  });

  it("keeps parameters as the same object reference as input_schema", async () => {
    const { toResponsesTools } = await import("../adapters/providers/codex-oauth.js");
    const schema = { type: "object", properties: { x: { type: "string" } } };
    const tool = { name: "RefCheck", input_schema: schema } as unknown as AnthropicTool;

    expect(toResponsesTools([tool])[0].parameters).toBe(schema);
  });

  it("re-inspects a sub-schema reachable from two branches (DAG, not a cycle)", async () => {
    const { inspectToolSchema } = await import("../adapters/providers/codex-oauth.js");
    const shared = { anyOf: [{ type: "string" }] };
    // shared is a sibling property (depth 2) and also nested five levels deep; a global
    // visited set would skip the deep re-encounter and cap maxDepth at the first branch.
    const schema = {
      type: "object",
      properties: {
        shallow: shared,
        deep: { properties: { a: { properties: { b: shared } } } },
      },
    };

    const result = inspectToolSchema(schema);
    expect(result.constructs).toEqual(["anyOf", "depth>5"]);
    expect(result.maxDepth).toBe(8);
  });
});

describe("native web search substitution", () => {
  it("states the WebFetch gap and logs only when a tool was removed", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { applyNativeSearchSubstitution, searchNote, __resetSubstitutionLogState } = await import("../adapters/web-search-substitution.js");
    __resetSubstitutionLogState();
    expect(searchNote).toContain("There is no server-side equivalent of WebFetch — you cannot retrieve one specific URL this way.");

    const stripped = {
      model: "x",
      messages: [],
      tools: [{ name: "WebFetch" }, { name: "Bash" }],
    } as unknown as AnthropicRequest;
    applyNativeSearchSubstitution(stripped, "openai");
    expect(stripped.tools?.map((tool) => tool.name)).toEqual(["Bash"]);
    expect(log).toHaveBeenCalledWith(
      "[ccx] web tools stripped for openai: WebFetch - native search substituted; logged once per lane per process; WebFetch has NO equivalent",
    );

    log.mockClear();
    const untouched = { model: "x", messages: [], tools: [{ name: "Bash" }] } as unknown as AnthropicRequest;
    applyNativeSearchSubstitution(untouched, "openai");
    expect(log).not.toHaveBeenCalled();
  });

  it("note:false (bench) still strips the client web tools but does not advertise server search", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { applyNativeSearchSubstitution, searchNote } = await import("../adapters/web-search-substitution.js");
    const req = {
      model: "x", messages: [], system: "base",
      tools: [{ name: "WebSearch" }, { name: "Bash" }],
    } as unknown as AnthropicRequest;
    applyNativeSearchSubstitution(req, "codex-oauth", { note: false });
    expect(req.tools?.map((tool) => tool.name)).toEqual(["Bash"]);
    expect(req.system).toBe("base");
    const normal = { model: "x", messages: [], system: "base" } as unknown as AnthropicRequest;
    applyNativeSearchSubstitution(normal, "codex-oauth");
    expect(normal.system).toBe("base" + searchNote);
  });

  it("logs the strip notice once per provider, not once per turn", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { applyNativeSearchSubstitution, __resetSubstitutionLogState } = await import("../adapters/web-search-substitution.js");
    __resetSubstitutionLogState();
    const mk = () => ({
      model: "x",
      messages: [],
      tools: [{ name: "WebSearch" }, { name: "WebFetch" }, { name: "Bash" }],
    }) as unknown as AnthropicRequest;

    applyNativeSearchSubstitution(mk(), "gemini");
    applyNativeSearchSubstitution(mk(), "gemini");
    applyNativeSearchSubstitution(mk(), "gemini");
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(
      "[ccx] web tools stripped for gemini: WebSearch,WebFetch - native search substituted; logged once per lane per process; WebFetch has NO equivalent",
    );

    // A different provider is a different lane: the notice fires again.
    applyNativeSearchSubstitution(mk(), "openai");
    expect(log).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledWith(
      "[ccx] web tools stripped for openai: WebSearch,WebFetch - native search substituted; logged once per lane per process; WebFetch has NO equivalent",
    );
  });

  it("keeps stripping and note injection on later calls even when the log is suppressed", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { applyNativeSearchSubstitution, searchNote, __resetSubstitutionLogState } = await import("../adapters/web-search-substitution.js");
    __resetSubstitutionLogState();
    const mk = () => ({
      model: "x",
      messages: [],
      system: "hello",
      tools: [{ name: "WebFetch" }, { name: "Bash" }],
    }) as unknown as AnthropicRequest;

    applyNativeSearchSubstitution(mk(), "gemini");
    const second = mk();
    applyNativeSearchSubstitution(second, "gemini");
    const third = mk();
    applyNativeSearchSubstitution(third, "gemini");

    expect(log).toHaveBeenCalledTimes(1);
    expect(second.tools?.map((tool) => tool.name)).toEqual(["Bash"]);
    expect(second.system).toContain("Do NOT use the WebSearch or WebFetch tools");
    expect(third.tools?.map((tool) => tool.name)).toEqual(["Bash"]);
    expect(third.system).toContain(searchNote.trim());
  });
});

describe("codex payload warning cap", () => {
  it("caps payloadWarningSteps at 512 conversations and evicts oldest first", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { chatCodexOAuth } = await import("../adapters/providers/codex-oauth.js");
    const fakeReply = {
      raw: { write: () => {}, end: () => {}, writableEnded: false },
    } as unknown as import("fastify").FastifyReply;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        body: new ReadableStream({ start(c) { c.close(); } }),
      })),
    );

    // 513 distinct conversations (each first-user-turn text >= 256 KiB so the payload
    // warning fires), one request per conversation.
    const bodyFor = (i: number) => ({
      model: "codex",
      messages: [{ role: "user", content: `payload-conversation-${i} ${"x".repeat(262_500)}` }],
    }) as unknown as AnthropicRequest;
    for (let i = 1; i <= 513; i++) {
      await chatCodexOAuth(fakeReply, bodyFor(i), "gpt-5.6-sol", "test-key");
    }
    const payloadLines = () =>
      log.mock.calls.filter(([line]) => String(line).includes("KiB (store:false"));

    expect(payloadLines()).toHaveLength(513);

    // Re-driving conversation #1 re-fires its warning: the 513th insert pushed the map
    // past the 512-entry cap and the oldest-inserted key (conversation #1) was evicted.
    // Without the cap the re-drive would stay silent, so 514 proves the eviction happened.
    await chatCodexOAuth(fakeReply, bodyFor(1), "gpt-5.6-sol", "test-key");
    expect(payloadLines()).toHaveLength(514);
  });
});
