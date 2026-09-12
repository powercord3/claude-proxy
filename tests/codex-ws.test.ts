import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  isCodexWsEnabled,
  runCodexWsTurn,
  resetCodexWsForTests,
  codexWsStatus,
} from "../adapters/providers/codex-ws.js";
import {
  normalizeMessagesForResponses,
  toResponsesInput,
  buildResponsesInputs,
} from "../adapters/providers/codex-oauth.js";
import type { ResponseItem } from "../adapters/providers/codex-oauth.js";
import type { AnthropicMessage } from "../adapters/types.js";

// ── Fake socket ──────────────────────────────────────────────────────────────
//
// The module is driven through its real entry point against a scripted socket, rather than by
// exporting the delta calculation and testing that directly. The delta calculation is the part
// most likely to be wrong, and it is only correct in combination with the baseline the module
// commits at response.completed -- a unit test of either half alone would pass while the pair
// disagreed. So the socket is the only thing replaced here.

type Script = (sent: Record<string, unknown>, reply: (frame: unknown) => void) => void;

let sentPayloads: Record<string, unknown>[] = [];
let script: Script;
let connectBehaviour: "open" | "fail" = "open";
let socketsOpened = 0;
// What the fake socket hands `onerror` when `connectBehaviour === "fail"`. Overridden per test
// to exercise describeSocketError's mining of `.error`/`.error.cause`; defaults to the shape
// most existing tests rely on (a plain `.message`, no `.error` at all).
let failEvent: { message?: string; error?: unknown } = { message: "refused" };
// The most recently constructed socket, so a test can fire onerror/onclose directly on it mid-
// turn -- rather than through `script`, which only ever drives `onmessage`.
let lastSocket: FakeSocket | null = null;

class FakeSocket {
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onerror: ((ev: { message?: string; error?: unknown }) => void) | null = null;
  onclose: ((ev: { code: number; reason: string }) => void) | null = null;
  closed = false;

  constructor(_url: string, _opts?: { headers?: Record<string, string> }) {
    socketsOpened += 1;
    lastSocket = this;
    queueMicrotask(() => {
      if (connectBehaviour === "fail") this.onerror?.(failEvent);
      else this.onopen?.();
    });
  }
  send(data: string) {
    const payload = JSON.parse(data) as Record<string, unknown>;
    sentPayloads.push(payload);
    queueMicrotask(() => script(payload, (frame) => this.onmessage?.({ data: JSON.stringify(frame) })));
  }
  close() {
    this.closed = true;
  }
}

const original = (globalThis as { WebSocket?: unknown }).WebSocket;

beforeEach(() => {
  (globalThis as { WebSocket?: unknown }).WebSocket = FakeSocket;
  sentPayloads = [];
  socketsOpened = 0;
  connectBehaviour = "open";
  failEvent = { message: "refused" };
  lastSocket = null;
  delete process.env.CCX_CODEX_WS;
  resetCodexWsForTests();
});

afterEach(() => {
  (globalThis as { WebSocket?: unknown }).WebSocket = original;
  delete process.env.CCX_CODEX_WS;
  resetCodexWsForTests();
});

// ── Helpers ──────────────────────────────────────────────────────────────────

const userMsg = (text: string): ResponseItem =>
  ({ type: "message", role: "user", content: [{ type: "input_text", text }] }) as unknown as ResponseItem;
const fnCall = (callId: string, args = "{}"): ResponseItem =>
  ({ type: "function_call", call_id: callId, name: "read_file", arguments: args }) as unknown as ResponseItem;
const fnOut = (callId: string, output: string): ResponseItem =>
  ({ type: "function_call_output", call_id: callId, output }) as unknown as ResponseItem;

const SHELL = { model: "gpt-5.6-luna", instructions: "be terse", store: false, stream: true };
// One arbitrary conversation identity shared by every test below that is not specifically
// exercising Finding 3's cross-conversation guard, so requiring conversationKey to match does not
// change any of their existing behaviour.
const CONVO = "convo-default";

/** A server turn that thinks, calls a tool, and completes. */
function toolCallScript(responseId: string, callId: string): Script {
  return (_sent, reply) => {
    reply({ type: "response.created", response: { id: responseId } });
    reply({
      type: "response.output_item.done",
      item: { type: "reasoning", summary: [], encrypted_content: "blob" },
    });
    reply({
      type: "response.output_item.done",
      item: {
        type: "function_call",
        id: "fc_server",
        status: "completed",
        call_id: callId,
        name: "read_file",
        arguments: "{}",
      },
    });
    reply({ type: "response.completed", response: { id: responseId, usage: { input_tokens: 10 } } });
  };
}

async function drain(turn: { events: AsyncGenerator<Record<string, unknown>> }) {
  const out: Record<string, unknown>[] = [];
  for await (const ev of turn.events) out.push(ev);
  return out;
}

// ── Gate ─────────────────────────────────────────────────────────────────────

describe("isCodexWsEnabled", () => {
  it("defaults to enabled when the variable is unset", () => {
    expect(isCodexWsEnabled()).toBe(true);
  });

  it.each(["0", "false", "off", "OFF", " False "])("treats %j as an opt-out", (v) => {
    process.env.CCX_CODEX_WS = v;
    expect(isCodexWsEnabled()).toBe(false);
  });

  it("returns null from runCodexWsTurn when opted out, without opening a socket", async () => {
    process.env.CCX_CODEX_WS = "0";
    const turn = await runCodexWsTurn({ shellBody: SHELL, input: [userMsg("hi")], headers: {}, conversationKey: CONVO });
    expect(turn).toBeNull();
    expect(socketsOpened).toBe(0);
  });
});

// ── The delta, which is the whole point ──────────────────────────────────────

describe("incremental continuation", () => {
  it("sends the full input on the first turn and no previous_response_id", async () => {
    script = toolCallScript("resp-1", "call-1");
    const turn = await runCodexWsTurn({ shellBody: SHELL, input: [userMsg("read a.txt")], headers: {}, conversationKey: CONVO });
    expect(turn).not.toBeNull();
    await drain(turn!);

    expect(turn!.incremental).toBe(false);
    expect(sentPayloads).toHaveLength(1);
    expect(sentPayloads[0].type).toBe("response.create");
    expect(sentPayloads[0].previous_response_id).toBeUndefined();
    expect(sentPayloads[0].input).toHaveLength(1);
  });

  it("sends only the new items on the second turn, chained to the first response id", async () => {
    script = toolCallScript("resp-1", "call-1");
    const t1 = await runCodexWsTurn({ shellBody: SHELL, input: [userMsg("read a.txt")], headers: {}, conversationKey: CONVO });
    await drain(t1!);

    // What Claude Code replays next turn: the original user message, the assistant's tool call
    // rebuilt from its tool_use block, and the tool result. Only the last is new.
    script = (_s, reply) => {
      reply({ type: "response.created", response: { id: "resp-2" } });
      reply({
        type: "response.output_item.done",
        item: { type: "message", role: "assistant", content: [{ type: "output_text", text: "3 lines" }] },
      });
      reply({ type: "response.completed", response: { id: "resp-2", usage: {} } });
    };
    const t2 = await runCodexWsTurn({
      shellBody: SHELL,
      input: [userMsg("read a.txt"), fnCall("call-1"), fnOut("call-1", "a\nb\nc")],
      headers: {},
      conversationKey: CONVO,
    });
    await drain(t2!);

    expect(t2!.incremental).toBe(true);
    expect(sentPayloads).toHaveLength(2);
    expect(sentPayloads[1].previous_response_id).toBe("resp-1");
    expect(sentPayloads[1].input).toEqual([
      { type: "function_call_output", call_id: "call-1", output: "a\nb\nc" },
    ]);
    // One socket served both turns; that pinning is the mechanism behind the cache result.
    expect(socketsOpened).toBe(1);
  });

  it("chains a third turn onto the second, absorbing the assistant message the server produced", async () => {
    script = toolCallScript("resp-1", "call-1");
    await drain((await runCodexWsTurn({ shellBody: SHELL, input: [userMsg("read a.txt")], headers: {}, conversationKey: CONVO }))!);

    script = (_s, reply) => {
      reply({ type: "response.created", response: { id: "resp-2" } });
      reply({
        type: "response.output_item.done",
        item: { type: "message", role: "assistant", content: [{ type: "output_text", text: "3 lines" }] },
      });
      reply({ type: "response.completed", response: { id: "resp-2", usage: {} } });
    };
    await drain(
      (await runCodexWsTurn({
        shellBody: SHELL,
        input: [userMsg("read a.txt"), fnCall("call-1"), fnOut("call-1", "a\nb\nc")],
        headers: {},
        conversationKey: CONVO,
      }))!,
    );

    script = (_s, reply) => {
      reply({ type: "response.created", response: { id: "resp-3" } });
      reply({ type: "response.completed", response: { id: "resp-3", usage: {} } });
    };
    const t3 = await runCodexWsTurn({
      shellBody: SHELL,
      input: [
        userMsg("read a.txt"),
        fnCall("call-1"),
        fnOut("call-1", "a\nb\nc"),
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "3 lines" }] } as unknown as ResponseItem,
        userMsg("thanks"),
      ],
      headers: {},
      conversationKey: CONVO,
    });
    await drain(t3!);

    expect(t3!.incremental).toBe(true);
    expect(sentPayloads[2].previous_response_id).toBe("resp-2");
    expect(sentPayloads[2].input).toEqual([
      { type: "message", role: "user", content: [{ type: "input_text", text: "thanks" }] },
    ]);
  });
});

// ── Fix C: server echo must be canonicalized the way the client will rebuild it ──────────────

describe("Fix C: server echo canonicalization", () => {
  it("groups a turn's interleaved text and tool calls into one message plus trailing calls, matching the client's rebuild", async () => {
    script = (_s, reply) => {
      reply({ type: "response.created", response: { id: "resp-1" } });
      reply({
        type: "response.output_item.done",
        item: { type: "message", role: "assistant", content: [{ type: "output_text", text: "First." }] },
      });
      reply({
        type: "response.output_item.done",
        item: { type: "function_call", call_id: "call-1", name: "read_file", arguments: "{}" },
      });
      reply({
        type: "response.output_item.done",
        item: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Second." }] },
      });
      reply({
        type: "response.output_item.done",
        item: { type: "function_call", call_id: "call-2", name: "read_file", arguments: "{}" },
      });
      reply({ type: "response.completed", response: { id: "resp-1", usage: {} } });
    };
    await drain((await runCodexWsTurn({ shellBody: SHELL, input: [userMsg("go")], headers: {}, conversationKey: CONVO }))!);

    // What Claude Code actually replays next turn: ALL text from the turn joined into ONE
    // message, THEN both tool calls -- never the interleaved shape the server streamed it in.
    const assistantTurn: ResponseItem = {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "First.Second." }],
    } as unknown as ResponseItem;
    script = (_s, reply) => {
      reply({ type: "response.created", response: { id: "resp-2" } });
      reply({ type: "response.completed", response: { id: "resp-2", usage: {} } });
    };
    const t2 = await runCodexWsTurn({
      shellBody: SHELL,
      input: [userMsg("go"), assistantTurn, fnCall("call-1"), fnCall("call-2"), userMsg("thanks")],
      headers: {},
      conversationKey: CONVO,
    });
    await drain(t2!);

    expect(t2!.incremental).toBe(true);
    expect(sentPayloads[1].input).toEqual([
      { type: "message", role: "user", content: [{ type: "input_text", text: "thanks" }] },
    ]);
  });

  it("matches a function_call whose arguments differ only in whitespace from the client's re-serialization", async () => {
    script = (_s, reply) => {
      reply({ type: "response.created", response: { id: "resp-1" } });
      reply({
        type: "response.output_item.done",
        // The server's own spacing -- a space after the colon.
        item: { type: "function_call", call_id: "call-1", name: "read_file", arguments: '{"path": "/a"}' },
      });
      reply({ type: "response.completed", response: { id: "resp-1", usage: {} } });
    };
    await drain((await runCodexWsTurn({ shellBody: SHELL, input: [userMsg("go")], headers: {}, conversationKey: CONVO }))!);

    script = toolCallScript("resp-2", "call-2");
    const t2 = await runCodexWsTurn({
      shellBody: SHELL,
      // Claude Code round-trips the call through a parsed object and JSON.stringify's it back
      // out compactly -- no space after the colon -- even though the server sent one.
      input: [userMsg("go"), fnCall("call-1", '{"path":"/a"}'), fnOut("call-1", "contents")],
      headers: {},
      conversationKey: CONVO,
    });
    await drain(t2!);

    expect(t2!.incremental).toBe(true);
    expect(sentPayloads[1].input).toEqual([
      { type: "function_call_output", call_id: "call-1", output: "contents" },
    ]);
  });
});

// ── Fix B: the WS path must not use the trailing-developer-reordered message list ────────────

describe("Fix B: trailing developer messages must not need history to reorder for the WS path", () => {
  // codex-oauth.ts builds the WS turn's `input` as `toResponsesInput(body.messages, [])` -- the
  // RAW, unreordered message list -- specifically so a trailing system-reminder/developer
  // message, replayed every turn, never shifts an earlier item's position. This test reproduces
  // that exact expression rather than driving codex-oauth.ts's chatCodexOAuthInner directly,
  // since that needs a live OAuth token and an upstream network call this suite must not make;
  // it exercises the real matching mechanism in codex-ws.ts end to end, and the contrasting test
  // below shows the SAME conversation would have gone full-resend under the pre-fix (reordered)
  // formula -- the exact divergence that made 1,993/2,043 production turns fall back to a full
  // resend. It does not, on its own, catch a regression that reverts the one-line wiring choice
  // in codex-oauth.ts itself; see the PR report.
  const msgs1: AnthropicMessage[] = [
    { role: "user", content: "u1" },
    { role: "developer", content: "d1" },
  ];
  const msgs2: AnthropicMessage[] = [
    { role: "user", content: "u1" },
    { role: "developer", content: "d1" },
    { role: "assistant", content: "ok" },
    { role: "user", content: "u2" },
    { role: "developer", content: "d2" },
  ];

  it("stays incremental on turn 2 despite a trailing developer message appended each turn", async () => {
    script = (_s, reply) => {
      reply({ type: "response.created", response: { id: "resp-1" } });
      reply({
        type: "response.output_item.done",
        item: { type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] },
      });
      reply({ type: "response.completed", response: { id: "resp-1", usage: {} } });
    };
    const t1 = await runCodexWsTurn({ shellBody: SHELL, input: toResponsesInput(msgs1, []), headers: {}, conversationKey: CONVO });
    await drain(t1!);

    script = toolCallScript("resp-2", "call-2");
    const t2 = await runCodexWsTurn({ shellBody: SHELL, input: toResponsesInput(msgs2, []), headers: {}, conversationKey: CONVO });
    await drain(t2!);

    expect(t2!.incremental).toBe(true);
    expect(sentPayloads[1].previous_response_id).toBe("resp-1");
    expect(sentPayloads[1].input).toEqual(toResponsesInput(msgs2, []).slice(3));
  });

  it("contrast: the pre-fix reordered input for the SAME conversation is not resumable", async () => {
    script = (_s, reply) => {
      reply({ type: "response.created", response: { id: "resp-1" } });
      reply({
        type: "response.output_item.done",
        item: { type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] },
      });
      reply({ type: "response.completed", response: { id: "resp-1", usage: {} } });
    };
    const t1 = await runCodexWsTurn({
      shellBody: SHELL,
      input: toResponsesInput(normalizeMessagesForResponses(msgs1), []),
      headers: {},
      conversationKey: CONVO,
    });
    await drain(t1!);

    script = toolCallScript("resp-2", "call-2");
    const t2 = await runCodexWsTurn({
      shellBody: SHELL,
      input: toResponsesInput(normalizeMessagesForResponses(msgs2), []),
      headers: {},
      conversationKey: CONVO,
    });
    await drain(t2!);

    // The reorder is relative to the END of the array, so "u1"'s position moves between turn 1
    // (nothing trails it) and turn 2 (both "u2" and "d2" trail it) -- a permuted history can
    // never be a strict prefix of what codex-ws.ts recorded as the baseline.
    expect(t2!.incremental).toBe(false);
  });
});

// ── Fix B regression: buildResponsesInputs is the only place the choice is made ──────────────
//
// The two tests above duplicate `toResponsesInput(body.messages, [])` inline, which cannot catch
// a revert of the one-line wiring choice in codex-oauth.ts's call site -- reported as an open gap
// in the original PR. `buildResponsesInputs` closes it: it is the actual exported function that
// call site now imports and uses for BOTH `httpInput` and `wsInput`, so this drives production
// code directly rather than a copy of its formula.

describe("Fix B escape hatch: CCX_CODEX_WS_RAW_ORDER=0 restores the reorder on the WS path", () => {
  // Fix B drops the trailing-developer reorder on the WS path so the item list is append-only.
  // The reorder was not incidental -- it exists so the model's last-read item is the user's
  // actionable task rather than an ambient system-reminder -- and its loss would degrade
  // instruction-following SILENTLY rather than raising anything. This flag is the documented way
  // back without a code edit, so it is tested rather than assumed to work.
  const messages: AnthropicMessage[] = [
    { role: "user", content: "u1" },
    { role: "assistant", content: [{ type: "tool_use", id: "call-1", name: "read_file", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "call-1", content: "out1" }] },
    { role: "developer", content: "reminder" },
  ];

  afterEach(() => {
    delete process.env.CCX_CODEX_WS_RAW_ORDER;
  });

  it("defaults to raw order, so wsInput differs from httpInput", () => {
    delete process.env.CCX_CODEX_WS_RAW_ORDER;
    const { httpInput, wsInput } = buildResponsesInputs(messages, []);
    expect(wsInput).toEqual(toResponsesInput(messages, []));
    expect(wsInput).not.toEqual(httpInput);
  });

  it("with the flag set to 0, wsInput takes the reordered list exactly like httpInput", () => {
    process.env.CCX_CODEX_WS_RAW_ORDER = "0";
    const { httpInput, wsInput } = buildResponsesInputs(messages, []);
    expect(wsInput).toEqual(toResponsesInput(normalizeMessagesForResponses(messages), []));
    expect(wsInput).toEqual(httpInput);
    // And the actionable item is last again -- the property the reorder exists to provide.
    expect(wsInput.at(-1)).toEqual({ type: "function_call_output", call_id: "call-1", output: "out1" });
  });

  it("only 0 disables it; any other value keeps raw order", () => {
    process.env.CCX_CODEX_WS_RAW_ORDER = "1";
    expect(buildResponsesInputs(messages, []).wsInput).toEqual(toResponsesInput(messages, []));
  });
});

describe("Fix B regression: buildResponsesInputs is the one place httpInput/wsInput are chosen", () => {
  it("reorders httpInput but leaves wsInput in raw order for a body ending in a trailing developer message", () => {
    const messages: AnthropicMessage[] = [
      { role: "user", content: "u1" },
      { role: "assistant", content: [{ type: "tool_use", id: "call-1", name: "read_file", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "call-1", content: "out1" }] },
      { role: "developer", content: "reminder" },
    ];

    const { httpInput, wsInput } = buildResponsesInputs(messages, []);

    // HTTPS path: the reorder still applies -- the trailing developer message stays trailing and
    // the tool_result (the last actionable item) moves to sit after it. This guards the HTTPS
    // path against a regression in the OTHER direction (accidentally routing it through
    // buildResponsesInputs's WS branch).
    expect(httpInput).toEqual(toResponsesInput(normalizeMessagesForResponses(messages), []));
    expect(httpInput.at(-1)).toEqual({ type: "function_call_output", call_id: "call-1", output: "out1" });

    // WS path: raw, append-only order -- the developer message trails, nothing moved.
    expect(wsInput).toEqual(toResponsesInput(messages, []));
    expect(wsInput.at(-1)).toEqual({
      type: "message",
      role: "developer",
      content: [{ type: "input_text", text: "reminder" }],
    });
  });

  it("keeps every turn's wsInput a strict prefix of the next turn's across a growing conversation with a new trailing developer message every turn", () => {
    // Mirrors what Claude Code actually replays: the full transcript so far, PLUS this turn's
    // tool call, tool result, and a fresh system-reminder developer message on the tail --
    // matching the production measurement that developer/system-reminder messages are replayed
    // in full every turn, one new one arriving on each.
    let messages: AnthropicMessage[] = [{ role: "user", content: "start the task" }];
    const wsInputCanonsByTurn: string[][] = [];

    for (let turn = 1; turn <= 6; turn++) {
      const { wsInput } = buildResponsesInputs(messages, []);
      wsInputCanonsByTurn.push(wsInput.map((item) => JSON.stringify(item)));

      messages = [
        ...messages,
        { role: "assistant", content: [{ type: "tool_use", id: `call-${turn}`, name: "read_file", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: `call-${turn}`, content: `out${turn}` }] },
        { role: "developer", content: `reminder-${turn}` },
      ];
    }

    for (let i = 0; i < wsInputCanonsByTurn.length - 1; i++) {
      const prev = wsInputCanonsByTurn[i];
      const next = wsInputCanonsByTurn[i + 1];
      // Load-bearing: this is exactly the property codex-ws.ts's findResumable needs to hold in
      // order to send a delta instead of a full resend. Reverting buildResponsesInputs to route
      // wsInput through the reordered messages breaks it, because the reorder is defined
      // relative to the END of the array and a new developer message lands on the tail turn.
      expect(next.length).toBeGreaterThan(prev.length);
      expect(next.slice(0, prev.length)).toEqual(prev);
    }
  });
});

// ── The cases where continuing would be wrong ────────────────────────────────

describe("refuses to continue a chain it cannot prove", () => {
  it("resends in full when an earlier item changed rather than being appended to", async () => {
    script = toolCallScript("resp-1", "call-1");
    await drain((await runCodexWsTurn({ shellBody: SHELL, input: [userMsg("read a.txt")], headers: {}, conversationKey: CONVO }))!);

    script = toolCallScript("resp-2", "call-2");
    const t2 = await runCodexWsTurn({
      shellBody: SHELL,
      // The first message is NOT what was sent before, so nothing about the server's state is
      // known to apply. Compaction and edited history both land here.
      input: [userMsg("read b.txt"), fnCall("call-1"), fnOut("call-1", "x")],
      headers: {},
      conversationKey: CONVO,
    });
    await drain(t2!);

    expect(t2!.incremental).toBe(false);
    expect(sentPayloads[1].previous_response_id).toBeUndefined();
    expect(sentPayloads[1].input).toHaveLength(3);
  });

  it("resends in full when the request shell changes", async () => {
    script = toolCallScript("resp-1", "call-1");
    await drain((await runCodexWsTurn({ shellBody: SHELL, input: [userMsg("read a.txt")], headers: {}, conversationKey: CONVO }))!);

    script = toolCallScript("resp-2", "call-2");
    const t2 = await runCodexWsTurn({
      // A different reasoning effort is a different request shape; the server's stored context
      // was produced under the old one.
      shellBody: { ...SHELL, reasoning: { effort: "high" } },
      input: [userMsg("read a.txt"), fnCall("call-1"), fnOut("call-1", "x")],
      headers: {},
      conversationKey: CONVO,
    });
    await drain(t2!);

    expect(t2!.incremental).toBe(false);
    expect(sentPayloads[1].previous_response_id).toBeUndefined();
  });

  it("abandons the chain after a server item it cannot model as a client echo", async () => {
    script = (_s, reply) => {
      reply({ type: "response.created", response: { id: "resp-1" } });
      // A genuinely unknown future item type -- NOT web_search_call, which Fix D below moves to
      // "skip" (absent from the baseline, chain preserved) rather than "unmodelled". This must
      // stay some type classifyOutputItem has never heard of, so it keeps exercising the
      // conservative default.
      reply({ type: "response.output_item.done", item: { type: "some_future_tool_call", id: "x_1" } });
      reply({ type: "response.completed", response: { id: "resp-1", usage: {} } });
    };
    await drain((await runCodexWsTurn({ shellBody: SHELL, input: [userMsg("search")], headers: {}, conversationKey: CONVO }))!);

    script = toolCallScript("resp-2", "call-2");
    const t2 = await runCodexWsTurn({
      shellBody: SHELL,
      input: [userMsg("search"), userMsg("again")],
      headers: {},
      conversationKey: CONVO,
    });
    await drain(t2!);

    // Guessing the echo form of an unknown item would splice a delta onto a context that does
    // not match. A full resend is the correct, merely-expensive answer.
    expect(t2!.incremental).toBe(false);
    expect(sentPayloads[1].previous_response_id).toBeUndefined();
  });

  it("Fix D: a web_search_call does not invalidate the baseline -- the next turn is still incremental", async () => {
    script = (_s, reply) => {
      reply({ type: "response.created", response: { id: "resp-1" } });
      reply({ type: "response.output_item.done", item: { type: "web_search_call", id: "ws_1" } });
      reply({ type: "response.completed", response: { id: "resp-1", usage: {} } });
    };
    await drain((await runCodexWsTurn({ shellBody: SHELL, input: [userMsg("search")], headers: {}, conversationKey: CONVO }))!);

    script = toolCallScript("resp-2", "call-2");
    const t2 = await runCodexWsTurn({
      shellBody: SHELL,
      input: [userMsg("search"), userMsg("again")],
      headers: {},
      conversationKey: CONVO,
    });
    await drain(t2!);

    // The client never echoes a web_search_call back (same as reasoning), so the baseline from
    // turn 1 is just [userMsg("search")] and turn 2 sends only the new item as a delta.
    expect(t2!.incremental).toBe(true);
    expect(sentPayloads[1].previous_response_id).toBe("resp-1");
    expect(sentPayloads[1].input).toEqual([
      { type: "message", role: "user", content: [{ type: "input_text", text: "again" }] },
    ]);
  });

  it("does not commit a baseline when the turn never completed", async () => {
    script = (_s, reply) => {
      reply({ type: "response.created", response: { id: "resp-1" } });
      reply({ type: "response.output_item.added", item: { type: "message" } });
      // no response.completed; the socket dies instead
      reply({ type: "error", status: 500, error: { message: "boom" } });
    };
    const t1 = await runCodexWsTurn({ shellBody: SHELL, input: [userMsg("hi")], headers: {}, conversationKey: CONVO });
    // The first frame arrived, so this is a mid-stream abort rather than a fallback.
    expect(t1).not.toBeNull();
    await expect(drain(t1!)).rejects.toThrow(/codex websocket/);
  });
});

// ── Fallback ─────────────────────────────────────────────────────────────────

describe("falls back to HTTPS rather than failing a request", () => {
  it("returns null and disables the transport when the socket will not open", async () => {
    connectBehaviour = "fail";
    const turn = await runCodexWsTurn({ shellBody: SHELL, input: [userMsg("hi")], headers: {}, conversationKey: CONVO });
    expect(turn).toBeNull();
    expect(codexWsStatus().enabled).toBe(false);

    // A dead network should be paid for once, not on every subsequent turn.
    connectBehaviour = "open";
    const again = await runCodexWsTurn({ shellBody: SHELL, input: [userMsg("hi")], headers: {}, conversationKey: CONVO });
    expect(again).toBeNull();
    expect(socketsOpened).toBe(1);
  });

  it("returns null on an error frame that arrives before any response content, and disables the transport (genuine fault)", async () => {
    // No structured `type`/`code`, and the message names nothing Fix A recognises as an
    // ordinary upstream refusal -- this must fall through to disabling the transport exactly as
    // before, not just fail this one turn over.
    script = (_s, reply) => reply({ type: "error", status: 500, error: { message: "internal server hiccup" } });
    const turn = await runCodexWsTurn({ shellBody: SHELL, input: [userMsg("hi")], headers: {}, conversationKey: CONVO });
    expect(turn).toBeNull();
    expect(codexWsStatus().enabled).toBe(false);
  });

  it("keeps the transport armed when the failure is only an expired chain", async () => {
    script = toolCallScript("resp-1", "call-1");
    await drain((await runCodexWsTurn({ shellBody: SHELL, input: [userMsg("read a.txt")], headers: {}, conversationKey: CONVO }))!);

    // The server's connection-local cache dropped the response id. This is an ordinary,
    // expected outcome and must not cost the process its websocket transport.
    script = (_s, reply) =>
      reply({ type: "error", status: 400, error: { message: "Invalid `previous_response_id`." } });
    const t2 = await runCodexWsTurn({
      shellBody: SHELL,
      input: [userMsg("read a.txt"), fnCall("call-1"), fnOut("call-1", "x")],
      headers: {},
      conversationKey: CONVO,
    });
    expect(t2).toBeNull();
    expect(codexWsStatus().enabled).toBe(true);

    script = toolCallScript("resp-9", "call-9");
    const t3 = await runCodexWsTurn({ shellBody: SHELL, input: [userMsg("fresh")], headers: {}, conversationKey: CONVO });
    expect(t3).not.toBeNull();
    await drain(t3!);
  });

  it("Fix A: fails a turn over to HTTPS on the real usage_limit_reached frame recovered from the production log, but leaves the transport ENABLED", async () => {
    // Verbatim from the production log (the proximate cause of 1,993/2,043 turns re-uploading
    // the full transcript): the old `disableTransport` branch matched on the raw frame text
    // rather than the structured `error.type` field, so this ordinary ChatGPT-plan quota refusal
    // killed the websocket for the rest of the process. `headers` in the recovered log line was
    // truncated (`{...}`); the exact header keys are not load-bearing here, so it is reproduced
    // as an empty object rather than guessed at.
    script = (_s, reply) =>
      reply({
        type: "error",
        error: {
          type: "usage_limit_reached",
          message: "The usage limit has been reached",
          plan_type: "plus",
          resets_at: 1788984352,
          eligible_promo: null,
          resets_in_seconds: 16584,
        },
        status_code: 429,
        headers: {},
      });
    const turn = await runCodexWsTurn({ shellBody: SHELL, input: [userMsg("hi")], headers: {}, conversationKey: CONVO });
    expect(turn).toBeNull();
    // Assert the REASON the turn failed over, not merely that it did: the transport must still
    // be armed for the very next turn.
    expect(codexWsStatus().enabled).toBe(true);

    script = toolCallScript("resp-9", "call-9");
    const again = await runCodexWsTurn({ shellBody: SHELL, input: [userMsg("fresh")], headers: {}, conversationKey: CONVO });
    expect(again).not.toBeNull();
    await drain(again!);
  });

  it("Fix A: falls back to the raw-frame regex when the error has no structured type/code field", async () => {
    // No `error.type`/`error.code` at all -- isNonTransportUpstreamRefusal has nothing structured
    // to read, so it must fall through to matching the raw frame text instead of disabling.
    script = (_s, reply) =>
      reply({ type: "error", message: "usage_limit_reached: try again later", status_code: 429 });
    const turn = await runCodexWsTurn({ shellBody: SHELL, input: [userMsg("hi")], headers: {}, conversationKey: CONVO });
    expect(turn).toBeNull();
    expect(codexWsStatus().enabled).toBe(true);
  });

  it("returns null when the runtime has no WebSocket global", async () => {
    delete (globalThis as { WebSocket?: unknown }).WebSocket;
    const turn = await runCodexWsTurn({ shellBody: SHELL, input: [userMsg("hi")], headers: {}, conversationKey: CONVO });
    expect(turn).toBeNull();
  });
});

// ── Concurrency ──────────────────────────────────────────────────────────────

describe("concurrent turns", () => {
  it("gives a second in-flight conversation its own socket rather than interleaving chains", async () => {
    let releaseFirst: (() => void) | null = null;
    script = (sent, reply) => {
      const isFirst = JSON.stringify(sent.input).includes("first");
      reply({ type: "response.created", response: { id: isFirst ? "resp-a" : "resp-b" } });
      const finish = () =>
        reply({ type: "response.completed", response: { id: isFirst ? "resp-a" : "resp-b", usage: {} } });
      if (isFirst) releaseFirst = finish;
      else finish();
    };

    const t1 = await runCodexWsTurn({ shellBody: SHELL, input: [userMsg("first")], headers: {}, conversationKey: CONVO });
    const drained1 = drain(t1!);
    const t2 = await runCodexWsTurn({ shellBody: SHELL, input: [userMsg("second")], headers: {}, conversationKey: CONVO });
    await drain(t2!);
    releaseFirst!();
    await drained1;

    // Two live conversations, two sockets. Sharing one would chain the second turn onto the
    // first conversation's response id.
    expect(socketsOpened).toBe(2);
  });
});

// ── Regression: a turn that ends in response.incomplete / response.failed ─────
//
// Reported by review as a critical baseline-corruption bug: handleEvent throws on these event
// types, the throw propagates out of the consumer's for-await, that calls .return() on the
// generator, and .return() resumes at the yield with a return completion -- which runs `finally`
// and SKIPS the baseline commit/invalidate block above it. The session therefore goes back into
// the pool holding the previous turn's baseline.
//
// The skip is real. Whether it corrupts anything is the actual question, and these tests answer
// it by resuming afterwards and checking the wire, rather than by inspecting internal state:
// the retained baseline describes the server's context at the PREVIOUS response id, and a failed
// response does not retroactively change that context. Skipping the commit keeps a correct older
// baseline instead of writing a wrong new one, which is the fail-safe direction.

describe("a turn that ends in response.incomplete", () => {
  it("leaves the next turn resuming from the last GOOD response, with a correct delta", async () => {
    script = toolCallScript("resp-1", "call-1");
    await drain((await runCodexWsTurn({ shellBody: SHELL, input: [userMsg("read a.txt")], headers: {}, conversationKey: CONVO }))!);

    // Turn 2 streams a real tool call, then truncates. Routine on a high reasoning effort.
    script = (_s, reply) => {
      reply({ type: "response.created", response: { id: "resp-2" } });
      reply({
        type: "response.output_item.done",
        item: { type: "function_call", id: "fc2", call_id: "call-2", name: "read_file", arguments: "{}" },
      });
      reply({
        type: "response.incomplete",
        response: { id: "resp-2", incomplete_details: { reason: "max_output_tokens" } },
      });
    };
    const t2 = await runCodexWsTurn({
      shellBody: SHELL,
      input: [userMsg("read a.txt"), fnCall("call-1"), fnOut("call-1", "a\nb")],
      headers: {},
      conversationKey: CONVO,
    });
    expect(t2).not.toBeNull();
    // The consumer (handleEvent) throws on this event type. Reproduce that exactly: abandon the
    // generator mid-iteration rather than draining it.
    await expect(
      (async () => {
        for await (const ev of t2!.events) {
          if (ev.type === "response.incomplete") throw new Error("Codex returned response.incomplete");
        }
      })(),
    ).rejects.toThrow(/response.incomplete/);

    // Now the turn that would expose a corrupted chain: the conversation carries on from where
    // the failed turn left off.
    script = (_s, reply) => {
      reply({ type: "response.created", response: { id: "resp-3" } });
      reply({ type: "response.completed", response: { id: "resp-3", usage: {} } });
    };
    const t3 = await runCodexWsTurn({
      shellBody: SHELL,
      input: [userMsg("read a.txt"), fnCall("call-1"), fnOut("call-1", "a\nb"), userMsg("try again")],
      headers: {},
      conversationKey: CONVO,
    });
    await drain(t3!);

    const sent = sentPayloads[sentPayloads.length - 1];
    // resp-1 is the last response the server actually completed, so it is the only id whose
    // context is known. Resuming from resp-2 would chain onto a truncated response.
    expect(sent.previous_response_id).toBe("resp-1");
    // And the delta must re-send everything after resp-1's context, including the tool result
    // that the abandoned turn already sent once. Dropping it would lose content silently.
    expect(sent.input).toEqual([
      { type: "function_call_output", call_id: "call-1", output: "a\nb" },
      { type: "message", role: "user", content: [{ type: "input_text", text: "try again" }] },
    ]);
  });

  it("does not strand the session as permanently busy after the abandoned turn", async () => {
    script = (_s, reply) => {
      reply({ type: "response.created", response: { id: "resp-1" } });
      reply({ type: "response.failed", response: { id: "resp-1", error: { message: "nope" } } });
    };
    const t1 = await runCodexWsTurn({ shellBody: SHELL, input: [userMsg("hi")], headers: {}, conversationKey: CONVO });
    await expect(
      (async () => {
        for await (const ev of t1!.events) if (ev.type === "response.failed") throw new Error("failed");
      })(),
    ).rejects.toThrow();

    // If busy leaked, this would open a second socket instead of reusing the first.
    script = toolCallScript("resp-2", "call-2");
    const t2 = await runCodexWsTurn({ shellBody: SHELL, input: [userMsg("hi again")], headers: {}, conversationKey: CONVO });
    await drain(t2!);
    expect(socketsOpened).toBe(1);
  });
});

// ── Regression: the reason-upgrade must never turn a completed turn into a failure ────────────
//
// closeSession lets a later, more informative close reason (typically onclose's `closed
// code=...`, arriving a moment after onerror's generic "websocket error") reach a turn that is
// still waiting on `failure`. Adversarial review found the first version of that upgrade wrote
// into `failure` unconditionally, so a turn that had ALREADY reached `response.completed` --
// `finished=true`, `failure` left null -- got its `failure` set retroactively by a stray
// onerror+onclose pair the socket fired on its way down anyway. That turned a delivered success
// into a thrown "codex websocket: closed code=..." abort, which downstream (codex-oauth.ts)
// reports as a mid-stream abort and appends a `[codex proxy error:CCX_STREAM_ABORTED]` block to
// an otherwise-complete response. Fixed by making the hook an upgrade of an EXISTING failure,
// never a creation: it only overwrites `failure` when something has already set it.

describe("reason upgrade", () => {
  it("does not fail a turn that already reached response.completed before the socket errors and closes", async () => {
    script = (_s, reply) => {
      reply({ type: "response.created", response: { id: "resp-1" } });
      reply({ type: "response.completed", response: { id: "resp-1", usage: {} } });
      // The socket dying on its way down, moments after the turn already finished cleanly.
      // onerror fires first (as it does on a real reset) and finds the turn already `finished`,
      // so it is a no-op; onclose then finds the session already torn down and offers its
      // (unused, here) upgrade. Neither may set `failure` from null.
      lastSocket!.onerror?.({ message: "websocket error" });
      lastSocket!.onclose?.({ code: 1006, reason: "" });
    };
    const t1 = await runCodexWsTurn({ shellBody: SHELL, input: [userMsg("hi")], headers: {}, conversationKey: CONVO });
    expect(t1).not.toBeNull();

    // The direct, externally-visible half of the bug: draining must resolve, not reject. A
    // reject here is exactly what would have reached codex-oauth.ts as a corrupting mid-stream
    // abort on a turn whose content had already been delivered.
    const events = await drain(t1!);
    expect(events.some((ev) => ev.type === "response.completed")).toBe(true);
  });

  it("surfaces the upgraded closed-code reason for a turn that is genuinely still in flight", async () => {
    script = (_s, reply) => {
      reply({ type: "response.created", response: { id: "resp-1" } });
      // No response.completed -- this turn never finishes on its own. onerror sets the generic
      // failure; onclose, arriving in the same synchronous pass, upgrades it before anything has
      // read `failure`.
      lastSocket!.onerror?.({ message: "websocket error" });
      lastSocket!.onclose?.({ code: 1006, reason: "" });
    };
    const t1 = await runCodexWsTurn({ shellBody: SHELL, input: [userMsg("hi")], headers: {}, conversationKey: CONVO });
    expect(t1).not.toBeNull();
    await expect(drain(t1!)).rejects.toThrow(/closed code=1006/);
  });
});

// ── describeSocketError, exercised through the connect-failure reporting path ─────────────────
//
// The module does not export describeSocketError, in keeping with this file's convention of
// driving behaviour through the real entry point (see the note at the top). The connect-failure
// path is where its return value becomes directly observable: `disableTransport` stores exactly
// what describeSocketError produced, and `codexWsStatus().disabled` reports it back.

describe("describeSocketError, via connect failure reporting", () => {
  it("falls back to the plain message for a bare error with nothing describeSocketError can add", async () => {
    connectBehaviour = "fail";
    // What Node v24's built-in undici actually hands onerror for both a refused connect and a
    // mid-connection RST, per the reviewer's measurement: an empty `.message` and a `.error`
    // that is a bare TypeError with no code/errno/syscall and an empty message of its own.
    failEvent = { message: "", error: new TypeError("") };
    const turn = await runCodexWsTurn({ shellBody: SHELL, input: [userMsg("hi")], headers: {}, conversationKey: CONVO });
    expect(turn).toBeNull();
    // Not "TypeError" -- that would be strictly less informative than the old literal and would
    // break existing log greps for it.
    expect(codexWsStatus().disabled).toBe("websocket error");
  });

  it("mines code/errno/syscall off .error when present", async () => {
    connectBehaviour = "fail";
    const rich = Object.assign(new Error("connect ECONNREFUSED"), {
      code: "ECONNREFUSED",
      errno: -4078,
      syscall: "connect",
    });
    failEvent = { message: "websocket error", error: rich };
    const turn = await runCodexWsTurn({ shellBody: SHELL, input: [userMsg("hi")], headers: {}, conversationKey: CONVO });
    expect(turn).toBeNull();
    const disabled = codexWsStatus().disabled;
    expect(disabled).toMatch(/ECONNREFUSED/);
    expect(disabled).toMatch(/syscall=connect/);
  });

  it("walks one level into .error.cause when .error itself is a bare wrapper", async () => {
    connectBehaviour = "fail";
    const cause = Object.assign(new Error("read ECONNRESET"), {
      code: "ECONNRESET",
      errno: -4077,
      syscall: "read",
    });
    const wrapper = new TypeError("");
    (wrapper as unknown as { cause?: unknown }).cause = cause;
    failEvent = { message: "", error: wrapper };
    const turn = await runCodexWsTurn({ shellBody: SHELL, input: [userMsg("hi")], headers: {}, conversationKey: CONVO });
    expect(turn).toBeNull();
    expect(codexWsStatus().disabled).toMatch(/ECONNRESET/);
  });
});

// ── Review finding 1: an abandoned turn must not release its socket while its response is live ──
//
// The bug: the turn generator's `finally` only closed the session when `failure` was set. A
// consumer that stops iterating (`for await` breaks -- client disconnect, Esc, an abort) BEFORE
// any terminal frame for this response arrives leaves `failure` null and `finished` false, so the
// session went straight back into the pool with the upstream response still streaming.
// `socket.onmessage` dispatches every frame to whatever `onFrame` is currently installed with no
// response-id check, so the NEXT turn's `onFrame` would then consume the abandoned response's
// late frames -- including its eventual `response.completed`, silently pairing the new turn's
// items with the old response's id.

describe("Review finding 1: an abandoned turn must not release its socket while its response is live", () => {
  it("closes the session when the consumer stops iterating before any terminal frame arrives, instead of returning it to the pool", async () => {
    script = (_s, reply) => {
      reply({ type: "response.created", response: { id: "resp-1" } });
      reply({
        type: "response.output_item.done",
        item: { type: "message", role: "assistant", content: [{ type: "output_text", text: "partial" }] },
      });
      // Deliberately no response.completed / response.failed / response.incomplete: the upstream
      // response is still "live" at the moment the consumer below walks away from it.
    };
    const t1 = await runCodexWsTurn({ shellBody: SHELL, input: [userMsg("hi")], headers: {}, conversationKey: CONVO });
    expect(t1).not.toBeNull();

    // The consumer disconnects after the first frame, before any terminal event -- calling
    // `.return()` on the generator, exactly like a client disconnect or an Esc-triggered abort.
    for await (const _ev of t1!.events) {
      break;
    }

    // Assert the REASON the pool is empty, not merely that a later turn happened to behave: the
    // socket itself must have been closed by the abandonment path.
    expect(lastSocket!.closed).toBe(true);
    expect(codexWsStatus().sessions).toBe(0);

    // A subsequent turn must open a brand-new socket. If the abandoned one had been returned to
    // the pool instead, this turn's `onFrame` could have been installed on it and would then
    // receive the FIRST turn's still-streaming, unrelated frames.
    script = toolCallScript("resp-2", "call-2");
    const t2 = await runCodexWsTurn({ shellBody: SHELL, input: [userMsg("hi again")], headers: {}, conversationKey: CONVO });
    expect(t2).not.toBeNull();
    await drain(t2!);
    expect(socketsOpened).toBe(2);
  });

  it("does NOT force-close a session that reaches response.completed and is then abandoned by the consumer", async () => {
    // Discriminates the fix from an over-eager version that closes on every `.return()`: by the
    // time `response.completed` is yielded, `finished` is already true, so a consumer that reads
    // it and then stops (the ordinary, ubiquitous shape of every other test in this file) must
    // still return the socket to the pool.
    script = toolCallScript("resp-1", "call-1");
    const t1 = await runCodexWsTurn({ shellBody: SHELL, input: [userMsg("hi")], headers: {}, conversationKey: CONVO });
    for await (const ev of t1!.events) {
      if (ev.type === "response.completed") break;
    }
    expect(lastSocket!.closed).toBe(false);
    expect(codexWsStatus().sessions).toBe(1);
  });
});

// ── Review finding 2: canonicalizeArguments must not equate different out-of-range integers ─────
//
// JSON.parse -> JSON.stringify is not lossless outside Number.MAX_SAFE_INTEGER: both
// "9007199254740993" and "9007199254740992" round-trip to the SAME text ("9007199254740992"),
// verified directly against this host's V8. The old canonicalizeArguments compared canonicalized
// text, so two DIFFERENT tool-call arguments could compare equal and splice a delta onto a
// context whose real recorded arguments differed.

describe("Review finding 2: canonicalizeArguments must not equate different out-of-range integers", () => {
  it("does not treat two different integers above 2^53 as equal -- falls back to a full resend rather than a corrupted delta", async () => {
    script = (_s, reply) => {
      reply({ type: "response.created", response: { id: "resp-1" } });
      reply({
        type: "response.output_item.done",
        item: { type: "function_call", call_id: "call-1", name: "read_file", arguments: '{"id":9007199254740993}' },
      });
      reply({ type: "response.completed", response: { id: "resp-1", usage: {} } });
    };
    await drain((await runCodexWsTurn({ shellBody: SHELL, input: [userMsg("go")], headers: {}, conversationKey: CONVO }))!);

    script = toolCallScript("resp-2", "call-2");
    const t2 = await runCodexWsTurn({
      shellBody: SHELL,
      // A DIFFERENT raw integer that the OLD parse+stringify canonicalization collapses to the
      // exact same text as the one above (both round to 9007199254740992) -- the precise
      // collision the finding describes.
      input: [userMsg("go"), fnCall("call-1", '{"id":9007199254740992}'), fnOut("call-1", "contents")],
      headers: {},
      conversationKey: CONVO,
    });
    await drain(t2!);

    // A false "equal" here would have sent only the function_call_output as a delta against
    // resp-1's context, silently pairing it with a call whose recorded arguments differ.
    expect(t2!.incremental).toBe(false);
    expect(sentPayloads[1].previous_response_id).toBeUndefined();
  });
});

// ── Review finding 3: sessions have no conversation identity, so the wrong chain can be resumed ──
//
// `findResumable` used to return the FIRST session in pool order whose baseline was a strict
// prefix, with no discriminator between conversations. Two sessions can hold content-identical
// (or nested-prefix) baselines while the server's own hidden state differs, because `reasoning`
// and `web_search_call` items are deliberately omitted from the baseline -- so a request
// continuing one conversation could resume a DIFFERENT one that merely looks like a prefix match.

describe("Review finding 3: conversation identity in the session pool", () => {
  const CONVO_A = "convo-a";
  const CONVO_B = "convo-b";

  const msgScript = (responseId: string, text: string): Script => (_s, reply) => {
    reply({ type: "response.created", response: { id: responseId } });
    reply({
      type: "response.output_item.done",
      item: { type: "message", role: "assistant", content: [{ type: "output_text", text }] },
    });
    reply({ type: "response.completed", response: { id: responseId, usage: {} } });
  };
  const assistantEcho = (text: string): ResponseItem =>
    ({ type: "message", role: "assistant", content: [{ type: "output_text", text }] }) as unknown as ResponseItem;

  it("does not cross-resume two sessions whose baselines are content-identical prefixes but belong to different conversations", async () => {
    // Force two independent sockets rather than one shared, reused connection: with only one
    // free session in the pool, a mismatched request would normally just reuse (and wipe) it, so
    // session A's first turn is held open (not yet completed) while session B's turn runs to
    // completion on its own, separate socket.
    let releaseA: (() => void) | null = null;
    script = (_s, reply) => {
      reply({ type: "response.created", response: { id: "resp-a1" } });
      reply({ type: "response.output_item.done", item: { type: "reasoning", summary: [], encrypted_content: "x" } });
      releaseA = () => {
        reply({
          type: "response.output_item.done",
          item: { type: "message", role: "assistant", content: [{ type: "output_text", text: "a1" }] },
        });
        reply({ type: "response.completed", response: { id: "resp-a1", usage: {} } });
      };
    };
    const turnA = await runCodexWsTurn({ shellBody: SHELL, input: [userMsg("u1")], headers: {}, conversationKey: CONVO_A });
    const drainedA = drain(turnA!);

    // Session B (conversation B): the SAME content, so its baseline ends up byte-identical to
    // A's -- exactly the "content-identical prefix, different conversation" case the finding
    // describes. A is still busy, so this is forced onto a brand-new socket.
    script = msgScript("resp-b1", "a1");
    await drain(
      (await runCodexWsTurn({ shellBody: SHELL, input: [userMsg("u1")], headers: {}, conversationKey: CONVO_B }))!,
    );
    expect(socketsOpened).toBe(2);

    releaseA!();
    await drainedA;

    // A request continuing conversation B, extending its baseline by one item. Session A (pool
    // index 0, created first) has an EQUAL-length, content-identical baseline, so a bare
    // first-match-wins scan with no identity check would return A instead of B.
    script = msgScript("resp-b2", "ignored");
    const t3 = await runCodexWsTurn({
      shellBody: SHELL,
      input: [userMsg("u1"), assistantEcho("a1"), userMsg("u2")],
      headers: {},
      conversationKey: CONVO_B,
    });
    await drain(t3!);

    expect(t3!.incremental).toBe(true);
    // Must chain onto B's response id, never A's -- resuming A would inherit A's hidden
    // server-side state (e.g. reasoning) under conversation B's identity.
    expect(sentPayloads[sentPayloads.length - 1].previous_response_id).toBe("resp-b1");
    expect(socketsOpened).toBe(2); // resumed an existing socket; did not open a third
  });

  it("prefers the longest matching baseline over a shorter one earlier in pool order", async () => {
    const CONVO_X = "convo-x-shared";

    // S1 (conversation X): baseline [u1, a1].
    script = msgScript("resp-x1", "a1");
    await drain(
      (await runCodexWsTurn({ shellBody: SHELL, input: [userMsg("u1")], headers: {}, conversationKey: CONVO_X }))!,
    );

    // Resume S1 with a turn that will be ABANDONED after response.failed. Per the documented
    // .return()-skips-the-commit-block behaviour (see the response.incomplete/failed regression
    // tests above), S1 goes back to the pool FREE but with its baseline UNCHANGED at [u1, a1] --
    // and, crucially, still BUSY until that abandonment runs, which is what forces the next turn
    // below onto a brand-new socket instead of resuming S1.
    let sendKbFailure: (() => void) | null = null;
    script = (_s, reply) => {
      reply({ type: "response.created", response: { id: "resp-kb" } });
      reply({ type: "response.output_item.done", item: { type: "reasoning", summary: [], encrypted_content: "x" } });
      sendKbFailure = () => reply({ type: "response.failed", response: { id: "resp-kb", error: { message: "nope" } } });
    };
    const turnKb = await runCodexWsTurn({
      shellBody: SHELL,
      input: [userMsg("u1"), assistantEcho("a1"), userMsg("marker")],
      headers: {},
      conversationKey: CONVO_X,
    });
    expect(turnKb).not.toBeNull();

    // While S1 is busy on the turn above, a second request for the SAME conversation has nothing
    // free to resume and opens S2 fresh, with a full send that grows to baseline length 4.
    script = msgScript("resp-x2", "a2");
    const t2 = await runCodexWsTurn({
      shellBody: SHELL,
      input: [userMsg("u1"), assistantEcho("a1"), userMsg("u2")],
      headers: {},
      conversationKey: CONVO_X,
    });
    await drain(t2!);
    expect(socketsOpened).toBe(2);

    // Now let S1's held turn fail and be abandoned, returning S1 to the pool free, still at its
    // ORIGINAL length-2 baseline (pool order: S1 first, S2 second; S2's baseline is longer).
    sendKbFailure!();
    await expect(
      (async () => {
        for await (const ev of turnKb!.events) {
          if (ev.type === "response.failed") throw new Error("failed");
        }
      })(),
    ).rejects.toThrow();

    // The deciding turn: both S1 (len 2) and S2 (len 4) are valid strict prefixes of this
    // request. Pool order alone would return S1 (checked first); the fix must return S2, the
    // longest match, sending the smallest correct delta.
    script = msgScript("resp-x3", "a3");
    const t4 = await runCodexWsTurn({
      shellBody: SHELL,
      input: [userMsg("u1"), assistantEcho("a1"), userMsg("u2"), assistantEcho("a2"), userMsg("u3")],
      headers: {},
      conversationKey: CONVO_X,
    });
    await drain(t4!);

    const sent = sentPayloads[sentPayloads.length - 1];
    expect(sent.previous_response_id).toBe("resp-x2");
    expect(sent.input).toEqual([{ type: "message", role: "user", content: [{ type: "input_text", text: "u3" }] }]);
    expect(socketsOpened).toBe(2); // resumed an existing socket; did not open a third
  });
});
