import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  isCodexWsEnabled,
  runCodexWsTurn,
  resetCodexWsForTests,
  codexWsStatus,
} from "../adapters/providers/codex-ws.js";
import type { ResponseItem } from "../adapters/providers/codex-oauth.js";

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

class FakeSocket {
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onerror: ((ev: { message?: string }) => void) | null = null;
  onclose: ((ev: { code: number; reason: string }) => void) | null = null;
  closed = false;

  constructor(_url: string, _opts?: { headers?: Record<string, string> }) {
    socketsOpened += 1;
    queueMicrotask(() => {
      if (connectBehaviour === "fail") this.onerror?.({ message: "refused" });
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
    const turn = await runCodexWsTurn({ shellBody: SHELL, input: [userMsg("hi")], headers: {} });
    expect(turn).toBeNull();
    expect(socketsOpened).toBe(0);
  });
});

// ── The delta, which is the whole point ──────────────────────────────────────

describe("incremental continuation", () => {
  it("sends the full input on the first turn and no previous_response_id", async () => {
    script = toolCallScript("resp-1", "call-1");
    const turn = await runCodexWsTurn({ shellBody: SHELL, input: [userMsg("read a.txt")], headers: {} });
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
    const t1 = await runCodexWsTurn({ shellBody: SHELL, input: [userMsg("read a.txt")], headers: {} });
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
    await drain((await runCodexWsTurn({ shellBody: SHELL, input: [userMsg("read a.txt")], headers: {} }))!);

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
    });
    await drain(t3!);

    expect(t3!.incremental).toBe(true);
    expect(sentPayloads[2].previous_response_id).toBe("resp-2");
    expect(sentPayloads[2].input).toEqual([
      { type: "message", role: "user", content: [{ type: "input_text", text: "thanks" }] },
    ]);
  });
});

// ── The cases where continuing would be wrong ────────────────────────────────

describe("refuses to continue a chain it cannot prove", () => {
  it("resends in full when an earlier item changed rather than being appended to", async () => {
    script = toolCallScript("resp-1", "call-1");
    await drain((await runCodexWsTurn({ shellBody: SHELL, input: [userMsg("read a.txt")], headers: {} }))!);

    script = toolCallScript("resp-2", "call-2");
    const t2 = await runCodexWsTurn({
      shellBody: SHELL,
      // The first message is NOT what was sent before, so nothing about the server's state is
      // known to apply. Compaction and edited history both land here.
      input: [userMsg("read b.txt"), fnCall("call-1"), fnOut("call-1", "x")],
      headers: {},
    });
    await drain(t2!);

    expect(t2!.incremental).toBe(false);
    expect(sentPayloads[1].previous_response_id).toBeUndefined();
    expect(sentPayloads[1].input).toHaveLength(3);
  });

  it("resends in full when the request shell changes", async () => {
    script = toolCallScript("resp-1", "call-1");
    await drain((await runCodexWsTurn({ shellBody: SHELL, input: [userMsg("read a.txt")], headers: {} }))!);

    script = toolCallScript("resp-2", "call-2");
    const t2 = await runCodexWsTurn({
      // A different reasoning effort is a different request shape; the server's stored context
      // was produced under the old one.
      shellBody: { ...SHELL, reasoning: { effort: "high" } },
      input: [userMsg("read a.txt"), fnCall("call-1"), fnOut("call-1", "x")],
      headers: {},
    });
    await drain(t2!);

    expect(t2!.incremental).toBe(false);
    expect(sentPayloads[1].previous_response_id).toBeUndefined();
  });

  it("abandons the chain after a server item it cannot model as a client echo", async () => {
    script = (_s, reply) => {
      reply({ type: "response.created", response: { id: "resp-1" } });
      reply({ type: "response.output_item.done", item: { type: "web_search_call", id: "ws_1" } });
      reply({ type: "response.completed", response: { id: "resp-1", usage: {} } });
    };
    await drain((await runCodexWsTurn({ shellBody: SHELL, input: [userMsg("search")], headers: {} }))!);

    script = toolCallScript("resp-2", "call-2");
    const t2 = await runCodexWsTurn({
      shellBody: SHELL,
      input: [userMsg("search"), userMsg("again")],
      headers: {},
    });
    await drain(t2!);

    // Guessing the echo form of an unknown item would splice a delta onto a context that does
    // not match. A full resend is the correct, merely-expensive answer.
    expect(t2!.incremental).toBe(false);
    expect(sentPayloads[1].previous_response_id).toBeUndefined();
  });

  it("does not commit a baseline when the turn never completed", async () => {
    script = (_s, reply) => {
      reply({ type: "response.created", response: { id: "resp-1" } });
      reply({ type: "response.output_item.added", item: { type: "message" } });
      // no response.completed; the socket dies instead
      reply({ type: "error", status: 500, error: { message: "boom" } });
    };
    const t1 = await runCodexWsTurn({ shellBody: SHELL, input: [userMsg("hi")], headers: {} });
    // The first frame arrived, so this is a mid-stream abort rather than a fallback.
    expect(t1).not.toBeNull();
    await expect(drain(t1!)).rejects.toThrow(/codex websocket/);
  });
});

// ── Fallback ─────────────────────────────────────────────────────────────────

describe("falls back to HTTPS rather than failing a request", () => {
  it("returns null and disables the transport when the socket will not open", async () => {
    connectBehaviour = "fail";
    const turn = await runCodexWsTurn({ shellBody: SHELL, input: [userMsg("hi")], headers: {} });
    expect(turn).toBeNull();
    expect(codexWsStatus().enabled).toBe(false);

    // A dead network should be paid for once, not on every subsequent turn.
    connectBehaviour = "open";
    const again = await runCodexWsTurn({ shellBody: SHELL, input: [userMsg("hi")], headers: {} });
    expect(again).toBeNull();
    expect(socketsOpened).toBe(1);
  });

  it("returns null on an error frame that arrives before any response content", async () => {
    script = (_s, reply) => reply({ type: "error", status: 400, error: { message: "nope" } });
    const turn = await runCodexWsTurn({ shellBody: SHELL, input: [userMsg("hi")], headers: {} });
    expect(turn).toBeNull();
  });

  it("keeps the transport armed when the failure is only an expired chain", async () => {
    script = toolCallScript("resp-1", "call-1");
    await drain((await runCodexWsTurn({ shellBody: SHELL, input: [userMsg("read a.txt")], headers: {} }))!);

    // The server's connection-local cache dropped the response id. This is an ordinary,
    // expected outcome and must not cost the process its websocket transport.
    script = (_s, reply) =>
      reply({ type: "error", status: 400, error: { message: "Invalid `previous_response_id`." } });
    const t2 = await runCodexWsTurn({
      shellBody: SHELL,
      input: [userMsg("read a.txt"), fnCall("call-1"), fnOut("call-1", "x")],
      headers: {},
    });
    expect(t2).toBeNull();
    expect(codexWsStatus().enabled).toBe(true);

    script = toolCallScript("resp-9", "call-9");
    const t3 = await runCodexWsTurn({ shellBody: SHELL, input: [userMsg("fresh")], headers: {} });
    expect(t3).not.toBeNull();
    await drain(t3!);
  });

  it("returns null when the runtime has no WebSocket global", async () => {
    delete (globalThis as { WebSocket?: unknown }).WebSocket;
    const turn = await runCodexWsTurn({ shellBody: SHELL, input: [userMsg("hi")], headers: {} });
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

    const t1 = await runCodexWsTurn({ shellBody: SHELL, input: [userMsg("first")], headers: {} });
    const drained1 = drain(t1!);
    const t2 = await runCodexWsTurn({ shellBody: SHELL, input: [userMsg("second")], headers: {} });
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
    await drain((await runCodexWsTurn({ shellBody: SHELL, input: [userMsg("read a.txt")], headers: {} }))!);

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
    const t1 = await runCodexWsTurn({ shellBody: SHELL, input: [userMsg("hi")], headers: {} });
    await expect(
      (async () => {
        for await (const ev of t1!.events) if (ev.type === "response.failed") throw new Error("failed");
      })(),
    ).rejects.toThrow();

    // If busy leaked, this would open a second socket instead of reusing the first.
    script = toolCallScript("resp-2", "call-2");
    const t2 = await runCodexWsTurn({ shellBody: SHELL, input: [userMsg("hi again")], headers: {} });
    await drain(t2!);
    expect(socketsOpened).toBe(1);
  });
});
