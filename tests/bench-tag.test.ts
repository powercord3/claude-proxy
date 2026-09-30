// Bench run tagging through the real gateway (bench PLAN.md S-T12, S-T03, §2.4 transport-only).
//
// Boots adapters/anthropic-gateway.ts as a child process on a free port with USERPROFILE/HOME
// pointed at a temp dir (so shortcuts.json, .env, pid file and provider-health are fixtures, never
// the live ~/.claude-proxy) and CCX_SERVED_LOG at a temp file. The anthropic and glm lanes point at a local fake
// Anthropic-compatible upstream (ANTHROPIC_UPSTREAM_URL / GLM_UPSTREAM_URL), so a request is
// actually served and the test sees the model id the gateway sent upstream. No real network or
// credential is involved.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, utimesSync } from "fs";
import { createServer } from "net";
import { createServer as createHttpServer, type Server } from "http";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { parseBenchUrl, parseDirectModel, benchFields, noteBenchRun } from "../adapters/bench-tag.js";

// Pure boundary cases a gateway round-trip would make slow to enumerate: which prefix shapes
// count as tagged, untagged, or not-bench, and that direct ids are never guessed.
describe("parseBenchUrl / parseDirectModel", () => {
  it("strips the prefix and keeps the rest of the path and query", () => {
    expect(parseBenchUrl("/v1/messages")).toBeNull();
    expect(parseBenchUrl("/bench/run-1/v1/messages?beta=true")).toEqual({
      ctx: { runTag: "run-1", untagged: false, direct: false }, url: "/v1/messages?beta=true",
    });
    expect(parseBenchUrl("/bench/run-1/direct/v1/messages")).toEqual({
      ctx: { runTag: "run-1", untagged: false, direct: true }, url: "/v1/messages",
    });
  });
  it("an empty, reserved or malformed tag is untagged, and the request still routes", () => {
    expect(parseBenchUrl("/bench//v1/messages")).toEqual({
      ctx: { runTag: null, untagged: true, rawTag: "", direct: false }, url: "/v1/messages",
    });
    expect(parseBenchUrl("/bench/v1/messages")).toEqual({
      ctx: { runTag: null, untagged: true, rawTag: "", direct: false }, url: "/v1/messages",
    });
    expect(parseBenchUrl("/bench/direct/v1/messages")).toEqual({
      ctx: { runTag: null, untagged: true, rawTag: "", direct: true }, url: "/v1/messages",
    });
    expect(parseBenchUrl("/bench/bad%20tag!/v1/messages")!.ctx).toEqual({
      runTag: null, untagged: true, rawTag: "bad tag!", direct: false,
    });
  });
  it("direct ids must be provider-qualified with a known provider", () => {
    // The @effort is split off, not left in the slug sent upstream (codex-oauth has no fake
    // upstream here, so this lane is checked at the parser; the gateway tests cover the wiring).
    expect(parseDirectModel("codex-oauth:gpt-5.5@high")).toEqual({ provider: "codex-oauth", model: "gpt-5.5", reasoning: "high" });
    expect(parseDirectModel("codex-oauth:gpt-5.5")).toEqual({ provider: "codex-oauth", model: "gpt-5.5" });
    // Claude Code's own internal requests name a bare claude-* id.
    expect(parseDirectModel("claude-haiku-4-5")).toEqual({ provider: "anthropic", model: "claude-haiku-4-5" });
    expect(parseDirectModel("sol")).toMatchObject({ error: expect.stringContaining("provider-qualified") });
    expect(parseDirectModel("nope:x")).toMatchObject({ error: expect.stringContaining('unknown provider "nope"') });
    expect(parseDirectModel("gpt-5.5@high")).toMatchObject({ error: expect.stringContaining("provider-qualified") });
  });
  // Clock-injected: the gateway process cannot be made to forget its runs within one test run.
  it("off-prefix request is untagged only while a run is active", () => {
    const t0 = 5_000_000_000_000;
    expect(benchFields(undefined, {}, t0)).toEqual({ run_tag: null });
    noteBenchRun("unit-run", t0);
    expect(benchFields(undefined, {}, t0 + 1000)).toMatchObject({
      run_tag: null, bench_untagged: true, bench_off_prefix: true, active_run_tags: ["unit-run"],
    });
    expect(benchFields(undefined, {}, t0 + 31 * 60 * 1000)).toEqual({ run_tag: null });
  });
});

const ROOT = resolve(__dirname, "..");
let home: string;
let logPath: string;
let shortcuts: string;
let port: number;
let child: ChildProcess;
let childOut = "";
let upstream: Server;
const upstreamSeen: any[] = [];

const SSE = [
  ["message_start", { type: "message_start", message: { id: "msg_fake", type: "message", role: "assistant", model: "x", content: [], stop_reason: null, usage: { input_tokens: 3, output_tokens: 0 } } }],
  ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
  ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } }],
  ["content_block_stop", { type: "content_block_stop", index: 0 }],
  ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } }],
  ["message_stop", { type: "message_stop" }],
].map(([e, d]) => `event: ${e}
data: ${JSON.stringify(d)}

`).join("");

function freePort(): Promise<number> {
  return new Promise((ok, fail) => {
    const s = createServer();
    s.once("error", fail);
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as any).port;
      s.close(() => ok(p));
    });
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function lines(): any[] {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

/** POST and return the served routing line + completion line for this request, plus what the
 * fake upstream received (undefined when the request never reached it). */
async function send(path: string, model: string, headers: Record<string, string> = {}) {
  const requestId = `t-${Math.random().toString(36).slice(2)}`;
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json", "x-client-request-id": requestId,
      "x-api-key": "fake-client-key", ...headers,
    },
    body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: "user", content: [{ type: "text", text: requestId }] }] }),
  });
  const text = await res.text();
  const up = upstreamSeen.find((b) => JSON.stringify(b.messages).includes(requestId));
  for (let i = 0; i < 100; i++) {
    const mine = lines().filter((l) => l.request_id === requestId);
    const route = mine.find((l) => l.kind !== "completion");
    const done = mine.find((l) => l.kind === "completion");
    if (route && done) return { status: res.status, text, route, done, up };
    await sleep(50);
  }
  return { status: res.status, text, route: undefined as any, done: undefined as any, up };
}

function setAlias(target: string, mtimeSec: number) {
  writeFileSync(shortcuts, JSON.stringify({ benchalias: target }));
  // map.ts re-reads on mtime change; pin distinct mtimes so the repoint is seen deterministically.
  utimesSync(shortcuts, mtimeSec, mtimeSec);
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "ccx-bench-"));
  mkdirSync(join(home, ".claude-proxy"), { recursive: true });
  shortcuts = join(home, ".claude-proxy", "shortcuts.json");
  logPath = join(home, "served.jsonl");
  setAlias("glm:gpt-a@high", 1_000_000);
  upstream = createHttpServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      upstreamSeen.push(JSON.parse(raw));
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(SSE);
    });
  });
  await new Promise<void>((ok) => upstream.listen(0, "127.0.0.1", () => ok()));
  const upUrl = `http://127.0.0.1:${(upstream.address() as any).port}`;
  port = await freePort();
  child = spawn(process.execPath, ["--import", "tsx", "adapters/anthropic-gateway.ts"], {
    cwd: ROOT,
    env: {
      ...process.env,
      USERPROFILE: home, HOME: home,
      CLAUDE_PROXY_PORT: String(port),
      CCX_SERVED_LOG: logPath,
      CCX_LANE_PROBE: "0",
      CCX_DEFAULT_PROVIDER: "", CCX_DEFAULT_MODEL: "", ANTHROPIC_API_KEY: "",
      ANTHROPIC_UPSTREAM_URL: upUrl, GLM_UPSTREAM_URL: upUrl, ZAI_API_KEY: "fake-glm-key",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout!.on("data", (d) => (childOut += d));
  child.stderr!.on("data", (d) => (childOut += d));
  for (let i = 0; i < 200; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/healthz`)).ok) return;
    } catch { /* not up yet */ }
    await sleep(100);
  }
  throw new Error(`gateway did not start:\n${childOut}`);
}, 30_000);

afterAll(() => {
  child?.kill();
  upstream?.close();
});

describe("gateway bench prefix (S-T12)", () => {
  it("tagged request routes like a normal one and both served lines carry run_tag", async () => {
    const r = await send("/bench/run-1/v1/messages", "benchalias", { "x-bench-run-tag": "run-1" });
    expect(r.status).toBe(200); // actually served by the upstream, not just logged
    expect(r.up?.model).toBe("gpt-a");
    expect(r.route).toMatchObject({
      run_tag: "run-1", bench: true, requested: "benchalias", resolved: "glm:gpt-a@high",
      header_run_tag: "run-1", run_tag_mismatch: false,
    });
    expect(r.route.transport_only).toBeUndefined();
    expect(r.done).toMatchObject({ kind: "completion", run_tag: "run-1", bench: true });
  });

  it("header disagreeing with the path is flagged; the path decides run_tag", async () => {
    const r = await send("/bench/run-1/v1/messages", "benchalias", { "x-bench-run-tag": "other" });
    expect(r.route).toMatchObject({ run_tag: "run-1", header_run_tag: "other", run_tag_mismatch: true });
  });

  it("empty and malformed tags are logged as untagged, not dropped", async () => {
    const empty = await send("/bench//v1/messages", "benchalias");
    expect(empty.status).toBe(200);
    expect(empty.route).toMatchObject({ run_tag: null, bench: true, bench_untagged: true, bench_raw_tag: "" });
    expect(empty.done).toMatchObject({ run_tag: null, bench_untagged: true });
    const bad = await send("/bench/bad%20tag!/v1/messages", "benchalias");
    expect(bad.route).toMatchObject({ run_tag: null, bench_untagged: true, bench_raw_tag: "bad tag!" });
  });

  it("off the prefix while a run is active: counted as an untagged bench request", async () => {
    // run-1 was seen by the tests above, so this request is a child that lost its base URL.
    const r = await send("/v1/messages", "benchalias");
    expect(r.status).toBe(200); // counted, not dropped
    expect(r.route.run_tag).toBeNull();
    expect(r.route.bench).toBeUndefined(); // it did not arrive on the prefix
    expect(r.route).toMatchObject({ bench_untagged: true, bench_off_prefix: true });
    expect(r.route.active_run_tags).toContain("run-1");
    expect(r.done).toMatchObject({ bench_untagged: true, bench_off_prefix: true });
  });

  it("direct mode serves the named id: @effort goes to reasoning, not into the upstream slug", async () => {
    const r = await send("/bench/run-1/direct/v1/messages", "glm:glm-5@high");
    expect(r.status).toBe(200);
    expect(r.up?.model).toBe("glm-5"); // the literal "glm-5@high" never reaches the upstream
    expect(r.route).toMatchObject({
      run_tag: "run-1", transport_only: true,
      requested: "glm:glm-5@high", resolved: "glm:glm-5@high", model: "glm-5", effort: "high",
    });
    expect(r.route.requested).toBe(r.route.resolved);
    expect(r.done).toMatchObject({ run_tag: "run-1", transport_only: true });
  });

  it("direct mode serves Claude Code's internal bare claude-* request verbatim", async () => {
    const r = await send("/bench/run-1/direct/v1/messages", "claude-haiku-4-5");
    expect(r.status).toBe(200); // not a 400 "provider-qualified" refusal
    expect(r.up?.model).toBe("claude-haiku-4-5"); // not remapped to another provider's model
    expect(r.route).toMatchObject({ transport_only: true, provider: "anthropic", model: "claude-haiku-4-5" });
  });

  it("direct mode refuses an alias instead of resolving it, and says why", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/bench/run-1/direct/v1/messages`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "benchalias", max_tokens: 1, messages: [{ role: "user", content: "hi" }] }),
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("provider-qualified");
  });
});

describe("alias repoint is named on the next served line (S-T03)", () => {
  it("repointing shortcuts.json changes the served model and records the change", async () => {
    setAlias("glm:gpt-a@high", 1_000_000);
    const before = await send("/bench/st03/v1/messages", "benchalias");
    expect(before.route.resolved).toBe("glm:gpt-a@high");
    setAlias("glm:gpt-b@low", 2_000_000);
    const after = await send("/bench/st03/v1/messages", "benchalias");
    expect(after.status).toBe(200);
    expect(after.up?.model).toBe("gpt-b"); // the repointed model is what upstream was asked for
    expect(after.route).toMatchObject({
      resolved: "glm:gpt-b@low", model: "gpt-b",
      alias_changed: true, previous_resolved: "glm:gpt-a@high", run_tag: "st03",
    });
    const again = await send("/bench/st03/v1/messages", "benchalias");
    expect(again.route.alias_changed).toBeUndefined(); // only the first line after the change
  });
});
