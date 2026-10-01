import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "child_process";
import { createServer, type Server } from "http";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { AddressInfo } from "net";

/**
 * End-to-end coverage for fallback chains (fallbacks.ts) and the recovery probe
 * (lane-probe.ts), through the real entry point: a SECOND gateway process on its own port,
 * with USERPROFILE/HOME pointed at a temp dir so it reads fixture shortcuts.json /
 * fallbacks.json / provider-health.json and never touches the live ~/.claude-proxy. Upstreams
 * are a local mock server standing in for Anthropic, OpenRouter and DeepSeek. Codex is left
 * with no tokens in the temp home, so its real adapter fails with "Not logged in" - its own
 * auth-expired classification - which is the codex lane-unavailability path under test.
 */

const home = mkdtempSync(join(tmpdir(), "ccx-fallback-"));
const stateDir = join(home, ".claude-proxy");
mkdirSync(stateDir, { recursive: true });

let mock: Server;
let gw: ChildProcess;
let port = 0;
let log = "";

function sseAnthropic(model: string): string {
  const ev = (type: string, data: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
  return (
    ev("message_start", { message: { model, id: "msg_up", type: "message", role: "assistant", content: [], usage: { input_tokens: 1, output_tokens: 0 } } }) +
    ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } }) +
    ev("content_block_delta", { index: 0, delta: { type: "text_delta", text: "from-anthropic" } }) +
    ev("content_block_stop", { index: 0 }) +
    ev("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } }) +
    ev("message_stop", {})
  );
}

function sseOpenAI(text: string): string {
  return (
    `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n` +
    `data: [DONE]\n\n`
  );
}

async function startMock(): Promise<number> {
  mock = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = JSON.parse(raw || "{}");
      const model = String(body.model);
      if (req.url === "/v1/messages") {
        if (model === "claude-fail-429") {
          res.writeHead(429, { "content-type": "application/json", "anthropic-ratelimit-unified-status": "rejected" });
          return res.end(JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "usage limit" } }));
        }
        if (model === "claude-fail-400") {
          res.writeHead(400, { "content-type": "application/json" });
          return res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "bad field" } }));
        }
        if (model === "claude-split") {
          // message_start delivered in three reads: the first cut lands inside the UTF-8
          // bytes of "é" in the id, the second inside the "model" key itself.
          const full = Buffer.from(sseAnthropic(model).replace('"message":{"model"', '"message":{"note":"é","model"'), "utf8");
          const e = full.indexOf(Buffer.from("é", "utf8")) + 1;
          const m = full.indexOf(Buffer.from('"model"')) + 4;
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.write(full.subarray(0, e));
          setTimeout(() => res.write(full.subarray(e, m)), 40);
          setTimeout(() => res.end(full.subarray(m)), 80);
          return;
        }
        if (model === "claude-die") {
          // 200 + headers, then the connection dies before the first body byte.
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.flushHeaders();
          setTimeout(() => res.destroy(), 50);
          return;
        }
        if (body.stream !== true) {
          res.writeHead(200, { "content-type": "application/json" });
          return res.end(JSON.stringify({ model, id: "msg_up", type: "message", role: "assistant", content: [{ type: "text", text: "from-anthropic" }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } }));
        }
        res.writeHead(200, { "content-type": "text/event-stream" });
        return res.end(sseAnthropic(model));
      }
      if (req.url === "/or/chat/completions" || req.url === "/ds/chat/completions") {
        if (model.includes("fail-402")) {
          res.writeHead(402, { "content-type": "application/json" });
          return res.end(JSON.stringify({ error: { message: "Insufficient Balance" } }));
        }
        res.writeHead(200, { "content-type": "text/event-stream" });
        return res.end(sseOpenAI(`from-${req.url.slice(1, 3)}:${model}`));
      }
      res.writeHead(404);
      res.end();
    });
  });
  await new Promise<void>((r) => mock.listen(0, "127.0.0.1", () => r()));
  return (mock.address() as AddressInfo).port;
}

async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
  const p = (s.address() as AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return p;
}

async function waitFor(pred: () => boolean, ms: number, what: string) {
  const until = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}\n--- gateway log ---\n${log}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function post(model: string, stream: boolean) {
  const r = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model, max_tokens: 32, stream, messages: [{ role: "user", content: "hi" }] }),
  });
  return { status: r.status, text: await r.text(), headers: r.headers };
}

function health(): Record<string, any> {
  return JSON.parse(readFileSync(join(stateDir, "provider-health.json"), "utf8"));
}

beforeAll(async () => {
  const mockPort = await startMock();
  port = await freePort();
  writeFileSync(
    join(stateDir, "shortcuts.json"),
    JSON.stringify({
      "slot-a": "anthropic:claude-fail-429",
      "slot-b": "anthropic:claude-fail-400",
      "slot-c": "codex-oauth:gpt-6-sol",
      "slot-e": "deepseek:ds-fail-402",
      "slot-a[1m]": "anthropic:claude-fail-429",
      "slot-f": "deepseek:ds-fail-402",
      "slot-g": "anthropic:claude-die",
      "slot-h": "openai:gpt-x",
    }),
  );
  writeFileSync(
    join(stateDir, "fallbacks.json"),
    JSON.stringify({
      version: 1,
      slots: {
        "slot-a": ["openrouter:or-ok"],
        "slot-b": ["openrouter:or-ok"],
        "slot-c": ["anthropic:claude-ok@medium", "openrouter:or-ok"],
        "slot-e": ["openrouter:or-ok"],
        "slot-f": ["anthropic:claude-split"],
        "slot-g": ["openrouter:or-ok"],
        "slot-h": ["openrouter:or-ok"],
      },
    }),
  );
  // The probe fixture: openrouter down on balance, with a reset time already in the past, so
  // the probe falls due on its first tick.
  writeFileSync(
    join(stateDir, "provider-health.json"),
    JSON.stringify({
      openrouter: {
        status: "down",
        reason: "balance-402",
        detected_at: "2026-09-20T00:00:00.000Z",
        last_error_snippet: "fixture",
        resets_at: "2026-09-20T01:00:00.000Z",
      },
      // Stale: resets_at passed, and with no OPENAI_API_KEY the probe cannot clear it.
      openai: {
        status: "down",
        reason: "codex-quota",
        detected_at: "2026-09-20T00:00:00.000Z",
        last_error_snippet: "fixture",
        resets_at: "2026-09-20T01:00:00.000Z",
      },
    }),
  );

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    USERPROFILE: home,
    HOME: home,
    CLAUDE_PROXY_PORT: String(port),
    ANTHROPIC_UPSTREAM_URL: `http://127.0.0.1:${mockPort}`,
    ANTHROPIC_API_KEY: "test-key",
    OPENROUTER_API_KEY: "test-key",
    OPENROUTER_BASE_URL: `http://127.0.0.1:${mockPort}/or`,
    DEEPSEEK_API_KEY: "test-key",
    OPENAI_API_KEY: "",
    DEEPSEEK_BASE_URL: `http://127.0.0.1:${mockPort}/ds`,
    CCX_CLAUDE_PASSTHROUGH: "1",
    CCX_LANE_PROBE_TICK_MS: "300",
    CCX_DIRECT_LOG: "",
  };
  gw = spawn(process.execPath, ["--import", "tsx", "adapters/anthropic-gateway.ts"], {
    cwd: process.cwd(),
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  gw.stdout!.on("data", (d) => (log += d));
  gw.stderr!.on("data", (d) => (log += d));
  await waitFor(() => log.includes("Proxy listening"), 30_000, "gateway start");
}, 40_000);

afterAll(async () => {
  gw?.kill();
  await new Promise<void>((r) => mock?.close(() => r()));
});

describe("recovery probe", () => {
  it("probes a down lane whose resets_at has passed and marks it ok as probed-200", async () => {
    await waitFor(() => log.includes("[probe] openrouter: recovered"), 10_000, "openrouter probe recovery");
    expect(health().openrouter.status).toBe("ok");
    expect(log).toContain("[probe] openrouter: probing (down since 2026-09-20T00:00:00.000Z: balance-402)");
    expect(log).toContain("[health] openrouter: down -> ok (probed-200, recovered from balance-402)");
    expect(log).toContain("[probe] openrouter: recovered (probed-200)");
  }, 15_000);
});

describe("fallback chains", () => {
  it("anthropic 429 before any output hops to the next target, keeping the alias's model name", async () => {
    const r = await post("slot-a", true);
    expect(r.status).toBe(200);
    expect(r.text).toContain("from-or:or-ok");
    // message_start carries what the primary would have echoed, not the fallback's model.
    const start = r.text.split("\n\n").find((b) => b.includes("message_start"))!;
    expect(start).toContain('"model":"claude-fail-429"');
    // The failed attempt's rate-limit headers are not left on the fallback's reply.
    expect(r.headers.get("anthropic-ratelimit-unified-status")).toBeNull();
    expect(log).toContain("[fallback] slot-a: anthropic:claude-fail-429 -> openrouter:or-ok (upstream-429)");
  });

  it("a non-availability error (400) surfaces unchanged with no hop", async () => {
    const r = await post("slot-b", true);
    expect(r.status).toBe(400);
    expect(r.text).toContain("invalid_request_error");
    expect(log).not.toContain("[fallback] slot-b");
  });

  it("codex auth failure (its own classifier) hops before output, non-streaming reply", async () => {
    const r = await post("slot-c", false);
    expect(r.status).toBe(200);
    const json = JSON.parse(r.text);
    expect(json.model).toBe("gpt-6-sol");
    expect(json.content[0].text).toBe("from-anthropic");
    expect(log).toContain("[fallback] slot-c: codex-oauth:gpt-6-sol -> anthropic:claude-ok@medium (auth-expired)");
    expect(health()["codex-oauth"].status).toBe("down");
  });

  it("a primary lane already known down is skipped without an attempt", async () => {
    const before = (log.match(/Not logged in to OpenAI/g) ?? []).length;
    const r = await post("slot-c", true);
    expect(r.status).toBe(200);
    expect(r.text).toContain("from-anthropic");
    expect(log).toContain("[fallback] slot-c: codex-oauth:gpt-6-sol -> anthropic:claude-ok@medium (primary lane down: auth-expired)");
    expect((log.match(/Not logged in to OpenAI/g) ?? []).length).toBe(before);
  });

  it("deepseek 402 hops to openrouter", async () => {
    const r = await post("slot-e", true);
    expect(r.status).toBe(200);
    expect(r.text).toContain("from-or:or-ok");
    expect(log).toContain("[fallback] slot-e: deepseek:ds-fail-402 -> openrouter:or-ok (balance-402)");
  });

  it("the chain is found for a [1m] companion alias and for an explicit @suffix", async () => {
    const r1 = await post("slot-a[1m]", true);
    expect(r1.status).toBe(200);
    expect(log).toContain("[fallback] slot-a[1m]: anthropic:claude-fail-429 -> openrouter:or-ok (upstream-429)");
    const r2 = await post("slot-a@high", true);
    expect(r2.status).toBe(200);
    expect(log).toContain("[fallback] slot-a@high: anthropic:claude-fail-429 -> openrouter:or-ok (upstream-429)");
  });

  it("model rewrite survives a model field and a multibyte char split across upstream chunks", async () => {
    const r = await post("slot-f", true);
    expect(r.status).toBe(200);
    expect(log).toContain("[fallback] slot-f: deepseek:ds-fail-402 -> anthropic:claude-split (primary lane down: balance-402)");
    const start = r.text.split("\n\n").find((b) => b.includes("message_start"))!;
    expect(start).toContain('"model":"ds-fail-402"');
    expect(start).toContain('"note":"é"');
    expect(r.text).not.toContain("claude-split");
    expect(r.text).toContain("from-anthropic");
  });

  it("anthropic passthrough defers headers while a hop exists: an upstream that dies before its first byte leaves the reply uncommitted", async () => {
    const r = await post("slot-g", true);
    // Before the fix the SSE headers were flushed on the upstream's 200, so this came back
    // as a 200 event-stream carrying an in-band error. "terminated" is not a lane-unavailable
    // class, so no hop - but the reply is still a real error status.
    expect(r.status).toBe(500);
    expect(r.headers.get("content-type")).not.toContain("text/event-stream");
  });

  it("a stale down record does not turn an unrelated error on the retried primary into a hop", async () => {
    const r = await post("slot-h", true);
    expect(r.status).toBe(401);
    expect(r.text).toContain("OPENAI_API_KEY not set");
    expect(log).not.toContain("[fallback] slot-h");
  });

  it("a corrupt fallbacks.json disables fallbacks and is logged once", async () => {
    writeFileSync(join(stateDir, "fallbacks.json"), "{ not json");
    const r1 = await post("slot-a", true);
    const r2 = await post("slot-a", true);
    expect(r1.status).toBe(429);
    expect(r2.status).toBe(429);
    expect((log.match(/\[fallback\] ignoring /g) ?? []).length).toBe(1);
  });
});
