// Responses-over-WebSocket transport for the ChatGPT Codex lane.
//
// ── Why this exists ──────────────────────────────────────────────────────────
//
// `store:false` on the HTTPS Responses endpoint makes every turn re-upload the whole
// transcript, so uploaded bytes are O(N^2) in tool calls, and a single prompt-cache miss
// re-bills the entire prefix at full price. CODEX-COST-WORK-2.md section 2 measured the four
// obvious state-carrying parameters -- `store:true`, `previous_response_id`, `conversation`,
// and server-side compaction -- as REFUSED on that endpoint, and concluded server-side
// conversation state was unavailable. That conclusion is correct *for the HTTPS endpoint* and
// wrong for this backend as a whole.
//
// The same host also speaks `wss://chatgpt.com/backend-api/codex/responses`, and on the
// WebSocket transport `previous_response_id` is ACCEPTED. Codex CLI itself uses it
// (codex-rs/codex-api/src/endpoint/responses_websocket.rs, codex-rs/core/src/client.rs); this
// module mirrors the parts of that design that matter here.
//
// Measured 2026-09-06, two interleaved ws/http pairs, 12 turns each over a ~35k-token prefix,
// one tool call per turn:
//
//   run          uncached tokens   uploaded   prompt-cache misses
//   ws pair 1             56,460    131 KiB   0/10
//   http pair 1           56,460  1,200 KiB   0/10
//   ws pair 2             56,460    131 KiB   0/10
//   http pair 2           91,097  1,210 KiB   1/10   <- one miss, +34,637 tokens (+61%)
//
// Two things to read off that table. Uploaded bytes fall ~9x at 12 turns and the ratio grows
// linearly with turn count, because only the delta goes on the wire. And both WebSocket runs
// returned *byte-identical* totals with zero misses, while HTTP varied: a WebSocket is one TCP
// connection to one replica, so the replica-routing roll that section 1.3 identified as the
// binding constraint is taken once at connect instead of once per request. That is the
// mechanism, and it is why this is a cost fix and not just a bandwidth fix -- section 1.3's
// climb-then-collapse pattern needs a mid-conversation reroute to trigger, and a pinned socket
// does not offer one.
//
// ── Safety posture ───────────────────────────────────────────────────────────
//
// This transport can never fail a request. `runCodexWsTurn` resolves only once the first frame
// of the response has arrived, so every failure mode before that point -- connect timeout, the
// 1008 policy close reported against Codex CLI on some networks, an `error` frame, an expired
// `previous_response_id` -- returns null and the caller silently uses the HTTPS path it would
// have used anyway. A failure also disables the transport for the rest of the process, matching
// `disable_websockets` in codex-rs/core/src/client.rs, so one bad network does not pay the
// connect timeout on every subsequent turn.
//
// Opt out entirely with CCX_CODEX_WS=0.

import { createHash } from "crypto";
import type { ResponseItem } from "./codex-oauth.js";

// ── Minimal WebSocket surface ────────────────────────────────────────────────
//
// Declared locally rather than taken from a lib: `@types/node` at the version this project
// pins does not declare the global, and the `headers` option on the constructor is a Node
// (undici) extension that the DOM lib does not model at all. Node 22+ ships the global at
// runtime; `hasWebSocket()` below is the runtime guard for anything older.

type WsEvent = { data: string };
type WsCloseEvent = { code: number; reason: string };
interface CodexSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: (() => void) | null;
  onmessage: ((ev: WsEvent) => void) | null;
  onerror: ((ev: { message?: string }) => void) | null;
  onclose: ((ev: WsCloseEvent) => void) | null;
}
type SocketCtor = new (
  url: string,
  opts?: { headers?: Record<string, string> },
) => CodexSocket;

const WS_URL = "wss://chatgpt.com/backend-api/codex/responses";

// The beta header Codex CLI sends on the websocket handshake
// (RESPONSES_WEBSOCKETS_V2_BETA_HEADER_VALUE in codex-rs/core/src/client.rs). The HTTPS path
// sends `responses=experimental` instead; sending that one here does not negotiate the
// transport.
const WS_BETA_HEADER = "responses_websockets=2026-02-06";

// Published limits for the transport: a connection lasts up to 60 minutes. Retire our own at 50
// so a turn is never handed a socket the server is about to close underneath it.
const MAX_SESSION_MS = 50 * 60 * 1000;
// A socket idle this long is very likely to have been reaped upstream; closing it ourselves
// turns a mid-turn failure into a clean reconnect.
const MAX_IDLE_MS = 10 * 60 * 1000;
const CONNECT_TIMEOUT_MS = 10_000;
// No frame at all for this long means the connection is dead rather than slow. Generous,
// because a high reasoning effort can think for minutes before emitting: codex#39771 is a
// false-positive idle timeout of exactly this kind.
const STREAM_IDLE_MS = 15 * 60 * 1000;
const MAX_SESSIONS = 8;

export function isCodexWsEnabled(): boolean {
  const raw = process.env.CCX_CODEX_WS;
  if (raw === undefined) return true;
  const v = raw.trim().toLowerCase();
  return !(v === "0" || v === "false" || v === "off");
}

function hasWebSocket(): boolean {
  return typeof (globalThis as { WebSocket?: unknown }).WebSocket === "function";
}

// ── Baseline bookkeeping ─────────────────────────────────────────────────────
//
// To send a delta we must know exactly what the server already holds. That is what we sent last
// turn, plus the items the server itself produced. The client half is easy -- we built it. The
// server half needs translating: Claude Code echoes an assistant turn back to us as text and
// tool_use blocks, which `toResponsesInput` rebuilds into `message` and `function_call` items,
// so we record the server's output in *that* form and compare our own vocabulary on both sides.
//
// Reasoning items are deliberately absent from the echo. The proxy drops replayed Anthropic
// thinking blocks (see toResponsesInput), so the client never sends one back, and on this
// transport it does not need to: the server's own connection-local state carries the previous
// turn's chain of thought. That is also why the local encrypted-reasoning cache is not spliced
// into anything sent here -- see the note in chatCodexOAuthInner.

type Baseline = {
  // Every item the server is known to hold, in our own vocabulary.
  items: string[];
  previousResponseId: string;
  // Hash of every request field except `input`. Mirrors responses_request_properties_match in
  // codex-rs/core/src/client.rs: a change to instructions, tools, effort, model or cache key
  // means this is a different request shape and the delta would be answered against the wrong
  // context, so we resend in full.
  shell: string;
};

function canon(item: unknown): string {
  return JSON.stringify(item);
}

/**
 * The form the client will echo a server output item back to us in, or null when the item is
 * one the client never replays (reasoning) or one we cannot model.
 *
 * A `null` from an item we cannot model is not the same as one we skip: the caller invalidates
 * the whole baseline on an unmodelled item, because guessing wrong here would splice a delta
 * onto a context that does not match and produce a subtly wrong conversation. Skipping costs
 * one full resend; guessing costs correctness.
 */
function echoFormOf(item: Record<string, unknown>): { canon: string | null; modelled: boolean } {
  const type = item.type as string | undefined;
  if (type === "reasoning") return { canon: null, modelled: true };
  if (type === "function_call") {
    return {
      canon: canon({
        type: "function_call",
        call_id: item.call_id,
        name: item.name,
        arguments: item.arguments,
      }),
      modelled: true,
    };
  }
  if (type === "message") {
    const content = (item.content as Array<{ type?: string; text?: string }> | undefined) ?? [];
    const text = content
      .filter((p) => p.type === "output_text" || p.type === "text")
      .map((p) => p.text ?? "")
      .join("");
    return {
      canon: canon({ type: "message", role: "assistant", content: [{ type: "output_text", text }] }),
      modelled: true,
    };
  }
  // web_search_call and anything else the backend grows later.
  return { canon: null, modelled: false };
}

// ── Session pool ─────────────────────────────────────────────────────────────
//
// Sessions are matched by CONTENT, not by prompt_cache_key. The cache key is shared globally on
// this host by design (CODEX-COST-WORK-2.md section 2 measures a shared key as *helping*
// caching), so keying a stateful chain by it would let one agent's conversation continue
// another's. Matching on "is this session's baseline a prefix of the request I am about to
// send" cannot make that mistake: a session only ever continues the conversation it actually
// holds.

type Session = {
  socket: CodexSocket;
  baseline: Baseline | null;
  openedAt: number;
  lastUsedAt: number;
  busy: boolean;
  /** When the in-flight turn was dispatched, for the stuck-busy watchdog in reapSessions. */
  turnStartedAt: number;
  closed: boolean;
  // Set when a frame arrives with no turn reading it, so a stray late frame cannot be handed to
  // the next turn as if it belonged to it.
  onFrame: ((raw: string) => void) | null;
  onDrop: ((reason: string) => void) | null;
};

const sessions: Session[] = [];
// Sockets that have been authorised to open but are not in `sessions` yet. Without this, two
// concurrent turns can both read `sessions.length` one below the cap, both pass the check, and
// both connect -- the cap is checked before an await and enforced after it.
let pendingConnects = 0;
let transportDisabled = false;
let disabledReason = "";

function closeSession(s: Session, reason: string) {
  if (s.closed) return;
  s.closed = true;
  const onDrop = s.onDrop;
  s.onDrop = null;
  s.onFrame = null;
  try {
    s.socket.close();
  } catch {
    /* already gone */
  }
  const i = sessions.indexOf(s);
  if (i !== -1) sessions.splice(i, 1);
  if (onDrop) onDrop(reason);
}

function reapSessions() {
  const now = Date.now();
  for (const s of [...sessions]) {
    if (s.busy) {
      // `busy` is cleared in the turn generator's `finally`, which only runs once something
      // iterates the generator. Every caller does, so this is a watchdog rather than a live
      // path -- but a caller that returned without consuming a turn would otherwise strand the
      // session busy forever, and the pool would silently shrink to nothing.
      if (now - s.turnStartedAt > STREAM_IDLE_MS * 2) closeSession(s, "turn never completed");
      continue;
    }
    if (now - s.openedAt > MAX_SESSION_MS) closeSession(s, "session age limit");
    else if (now - s.lastUsedAt > MAX_IDLE_MS) closeSession(s, "idle");
  }
}

/** Disable the transport for the life of the process after a failure. */
function disableTransport(reason: string) {
  if (transportDisabled) return;
  transportDisabled = true;
  disabledReason = reason;
  for (const s of [...sessions]) closeSession(s, "transport disabled");
  console.log(
    `[codex] websocket transport disabled for this process (${reason}) - falling back to HTTPS. Set CCX_CODEX_WS=0 to skip the attempt entirely.`,
  );
}

// Closing the pool on the way down is not tidiness, it is the other half of a real bug.
// `process.exit()` with an open WebSocket handle aborts Node on Windows with
// `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)` and exit code 127; see the exitSoon
// comment in bin/lib/pid-manager.js. That fix defers the exit by a tick, which only helps if
// something has actually asked the sockets to close by then. This is that something.
//
// Registered on first connect rather than at module load, so importing this module -- which a
// test or a one-shot script may do without ever opening a socket -- adds no process listeners.
let signalHandlersRegistered = false;
function registerShutdownHandlers() {
  if (signalHandlersRegistered) return;
  signalHandlersRegistered = true;
  const closeAll = () => {
    for (const s of [...sessions]) closeSession(s, "process shutting down");
  };
  // Not `once`: pid-manager's handler for the same signal is what actually exits, and both
  // must run. Node dispatches every listener for a signal in registration order.
  process.on("SIGINT", closeAll);
  process.on("SIGTERM", closeAll);
  process.on("beforeExit", closeAll);
}

function connect(headers: Record<string, string>): Promise<Session> {
  registerShutdownHandlers();
  return new Promise((resolve, reject) => {
    const Ctor = (globalThis as unknown as { WebSocket: SocketCtor }).WebSocket;
    let socket: CodexSocket;
    try {
      socket = new Ctor(WS_URL, { headers: { ...headers, "OpenAI-Beta": WS_BETA_HEADER } });
    } catch (err) {
      reject(new Error(`websocket construct failed: ${String(err)}`));
      return;
    }
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        socket.close();
      } catch {
        /* nothing to close */
      }
      reject(new Error(`connect timeout after ${CONNECT_TIMEOUT_MS}ms`));
    }, CONNECT_TIMEOUT_MS);

    const session: Session = {
      socket,
      baseline: null,
      openedAt: Date.now(),
      lastUsedAt: Date.now(),
      busy: false,
      turnStartedAt: 0,
      closed: false,
      onFrame: null,
      onDrop: null,
    };

    socket.onopen = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(session);
    };
    socket.onerror = (ev) => {
      const message = ev?.message ? String(ev.message) : "websocket error";
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(new Error(message));
        return;
      }
      closeSession(session, message);
    };
    socket.onclose = (ev) => {
      const reason = `closed code=${ev?.code ?? "?"}${ev?.reason ? ` reason=${ev.reason}` : ""}`;
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(new Error(reason));
        return;
      }
      closeSession(session, reason);
    };
    socket.onmessage = (ev) => {
      session.lastUsedAt = Date.now();
      if (session.onFrame) session.onFrame(String(ev.data));
    };
  });
}

// ── One turn ─────────────────────────────────────────────────────────────────

export type CodexWsTurn = {
  /**
   * Parsed Responses events, in order, ending after `response.completed`. The first event has
   * already arrived by the time the turn is handed over, so consuming this is the point of no
   * return: a failure from here on is a mid-stream abort, not a reason to retry on HTTPS.
   */
  events: AsyncGenerator<Record<string, unknown>>;
  /** True when only the delta went on the wire. */
  incremental: boolean;
  /** Items actually sent, for logging. */
  sentItems: number;
  /** Bytes actually sent, for logging. */
  sentBytes: number;
};

export type CodexWsParams = {
  /** The request body the HTTPS path would have sent, minus `input`. */
  shellBody: Record<string, unknown>;
  /** Full logical input for this turn, built WITHOUT locally cached reasoning. */
  input: ResponseItem[];
  /** Headers the HTTPS path would have sent, minus Content-Type/Accept/OpenAI-Beta. */
  headers: Record<string, string>;
};

function shellHashOf(shellBody: Record<string, unknown>): string {
  return createHash("sha1").update(JSON.stringify(shellBody)).digest("hex").slice(0, 16);
}

/**
 * Find a session whose baseline is a strict prefix of `itemCanons`, so this turn can be sent as
 * a delta against it.
 */
function findResumable(itemCanons: string[], shell: string): Session | null {
  for (const s of sessions) {
    if (s.busy || s.closed || !s.baseline) continue;
    if (s.baseline.shell !== shell) continue;
    const base = s.baseline.items;
    if (base.length > itemCanons.length) continue;
    let ok = true;
    for (let i = 0; i < base.length; i++) {
      if (base[i] !== itemCanons[i]) {
        ok = false;
        break;
      }
    }
    if (ok) return s;
  }
  return null;
}

function takeFreeSession(): Session | null {
  for (const s of sessions) {
    if (!s.busy && !s.closed) return s;
  }
  return null;
}

/**
 * Attempt this turn over the WebSocket transport.
 *
 * Returns null whenever the HTTPS path should be used instead. Never throws, and never emits
 * anything to the client: everything it can go wrong with happens before the first byte of the
 * response is handed back.
 */
export async function runCodexWsTurn(params: CodexWsParams): Promise<CodexWsTurn | null> {
  if (!isCodexWsEnabled() || transportDisabled || !hasWebSocket()) return null;
  reapSessions();

  const shell = shellHashOf(params.shellBody);
  const itemCanons = params.input.map(canon);

  let session = findResumable(itemCanons, shell);
  let incremental = false;
  let deltaItems: ResponseItem[] = params.input;
  let previousResponseId: string | null = null;

  if (session && session.baseline) {
    const baseLen = session.baseline.items.length;
    // An empty delta would ask the model to answer again with no new information. Nothing in
    // this proxy produces one (every turn carries at least a tool result or a user message),
    // but treat it as unresumable rather than sending a degenerate request.
    if (baseLen < itemCanons.length) {
      incremental = true;
      deltaItems = params.input.slice(baseLen);
      previousResponseId = session.baseline.previousResponseId;
    } else {
      session = null;
    }
  }

  if (!session) {
    session = takeFreeSession();
    // A reused connection with a baseline that did not match is being restarted from scratch:
    // drop the stale chain so a later turn cannot match against it.
    if (session) session.baseline = null;
  }

  if (!session) {
    if (sessions.length + pendingConnects >= MAX_SESSIONS) {
      // Every socket is mid-turn. Concurrency on this lane is real (three agents sharing one
      // cache key is a supported shape), so this is an ordinary outcome, not an error.
      return null;
    }
    pendingConnects += 1;
    try {
      session = await connect(params.headers);
      sessions.push(session);
    } catch (err) {
      disableTransport(err instanceof Error ? err.message : String(err));
      return null;
    } finally {
      pendingConnects -= 1;
    }
  }

  const payload: Record<string, unknown> = {
    type: "response.create",
    ...params.shellBody,
    input: deltaItems,
  };
  if (previousResponseId) payload.previous_response_id = previousResponseId;
  const text = JSON.stringify(payload);

  const active = session;
  active.busy = true;
  active.turnStartedAt = Date.now();
  active.lastUsedAt = Date.now();

  // ── Frame plumbing ─────────────────────────────────────────────────────────
  const queue: Record<string, unknown>[] = [];
  let waiter: (() => void) | null = null;
  let finished = false;
  let failure: string | null = null;
  // Rebuilt as the response streams; committed to the session only at response.completed.
  const serverEcho: string[] = [];
  let baselineUsable = true;
  let responseId = "";

  const wake = () => {
    const w = waiter;
    waiter = null;
    if (w) w();
  };

  active.onDrop = (reason) => {
    if (finished) return;
    failure = reason;
    finished = true;
    wake();
  };
  active.onFrame = (raw) => {
    if (finished) return;
    let ev: Record<string, unknown>;
    try {
      ev = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }
    const type = ev.type as string | undefined;

    // The transport wraps upstream errors in an `error` frame rather than an HTTP status. An
    // expired or unknown previous_response_id arrives here as `Invalid previous_response_id`,
    // which is recoverable: the caller resends in full over HTTPS and the next turn opens a
    // fresh chain.
    if (type === "error") {
      failure = `error frame: ${raw.slice(0, 400)}`;
      finished = true;
      wake();
      return;
    }
    if (type === "response.failed" || type === "response.incomplete") {
      // Not a transport failure -- the model genuinely failed this turn. Pass it through so the
      // existing handler reports it, rather than silently re-running the turn on HTTPS.
      queue.push(ev);
      finished = true;
      wake();
      return;
    }
    if (type === "response.created") {
      const r = ev.response as { id?: string } | undefined;
      if (r?.id) responseId = r.id;
    }
    if (type === "response.output_item.done") {
      const item = ev.item as Record<string, unknown> | undefined;
      if (item) {
        const { canon: c, modelled } = echoFormOf(item);
        if (!modelled) baselineUsable = false;
        else if (c) serverEcho.push(c);
      }
    }
    if (type === "response.completed") {
      const r = ev.response as { id?: string } | undefined;
      if (r?.id) responseId = r.id;
      queue.push(ev);
      finished = true;
      wake();
      return;
    }
    queue.push(ev);
    wake();
  };

  try {
    active.socket.send(text);
  } catch (err) {
    active.busy = false;
    closeSession(active, `send failed: ${String(err)}`);
    disableTransport(err instanceof Error ? err.message : String(err));
    return null;
  }

  // Wait for the first frame. This is the fallback boundary: before it, the HTTPS path is still
  // available and nothing has been written downstream.
  const first = await new Promise<Record<string, unknown> | null>((resolve) => {
    const timer = setTimeout(() => {
      failure = `no first frame within ${CONNECT_TIMEOUT_MS}ms`;
      finished = true;
      resolve(null);
    }, CONNECT_TIMEOUT_MS);
    waiter = () => {
      clearTimeout(timer);
      resolve(queue.shift() ?? null);
    };
    if (queue.length || finished) {
      clearTimeout(timer);
      waiter = null;
      resolve(queue.shift() ?? null);
    }
  });

  if (!first) {
    active.busy = false;
    active.onFrame = null;
    active.onDrop = null;
    const reason = failure ?? "no first frame";
    closeSession(active, reason);
    // An expired chain is a normal consequence of the server's connection-local cache and must
    // not disable the transport; a dead socket should.
    if (!/previous_response_id/i.test(reason)) disableTransport(reason);
    else console.log(`[codex] ws chain expired (${reason.slice(0, 120)}) - resending in full over HTTPS`);
    return null;
  }

  async function* events(): AsyncGenerator<Record<string, unknown>> {
    try {
      yield first as Record<string, unknown>;
      while (true) {
        if (queue.length) {
          yield queue.shift() as Record<string, unknown>;
          continue;
        }
        if (finished) break;
        let timedOut = false;
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            timedOut = true;
            resolve();
          }, STREAM_IDLE_MS);
          waiter = () => {
            clearTimeout(timer);
            resolve();
          };
        });
        if (timedOut) {
          failure = `idle timeout after ${STREAM_IDLE_MS}ms`;
          break;
        }
      }
      while (queue.length) yield queue.shift() as Record<string, unknown>;
      if (failure) throw new Error(`codex websocket: ${failure}`);

      // Commit the new baseline only on a clean completion. A turn that aborted leaves the
      // session's chain untouched and unusable, which is what we want: the next turn will not
      // match it and will resend in full.
      if (responseId && baselineUsable) {
        active.baseline = {
          items: [...itemCanons, ...serverEcho],
          previousResponseId: responseId,
          shell,
        };
      } else {
        active.baseline = null;
      }
    } finally {
      active.busy = false;
      active.onFrame = null;
      active.onDrop = null;
      active.lastUsedAt = Date.now();
      if (failure) closeSession(active, failure);
    }
  }

  return {
    events: events(),
    incremental,
    sentItems: deltaItems.length,
    sentBytes: Buffer.byteLength(text, "utf8"),
  };
}

/** Test seam: forget every pooled connection and re-arm the transport. */
export function resetCodexWsForTests() {
  for (const s of [...sessions]) closeSession(s, "test reset");
  sessions.length = 0;
  pendingConnects = 0;
  transportDisabled = false;
  disabledReason = "";
}

/** Diagnostics for the status line. */
export function codexWsStatus(): { enabled: boolean; sessions: number; disabled: string | null } {
  return {
    enabled: isCodexWsEnabled() && !transportDisabled,
    sessions: sessions.length,
    disabled: transportDisabled ? disabledReason : null,
  };
}
