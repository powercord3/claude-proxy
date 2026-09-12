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
  onerror: ((ev: { message?: string; error?: unknown }) => void) | null;
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
 * Fix C (part 2): `arguments` is a JSON string, and the server's spacing is not guaranteed to
 * match what Claude Code re-emits when it round-trips a tool call through a parsed object and
 * back (`JSON.stringify(block.input)` in toResponsesInput). One byte of whitespace must not
 * refuse a whole delta, so both sides of the comparison are canonicalized through parse+
 * stringify before being compared. A string that fails to parse is left unchanged rather than
 * dropped -- an item we cannot canonicalize should still compare literally, not disappear.
 */
function canonicalizeArguments(raw: unknown): unknown {
  if (typeof raw !== "string") return raw;
  try {
    return JSON.stringify(JSON.parse(raw));
  } catch {
    return raw;
  }
}

/**
 * Canonicalize one item for baseline comparison, applying the `arguments` normalization above to
 * `function_call` items. Key order matters (`canon` is a plain JSON.stringify), so this keeps
 * the existing `type, call_id, name, arguments` order by overriding a key already present in the
 * spread rather than reconstructing the object.
 */
function canonItem(item: Record<string, unknown>): string {
  if (item.type === "function_call") {
    return canon({ ...item, arguments: canonicalizeArguments(item.arguments) });
  }
  return canon(item);
}

type OutputClassification =
  | { kind: "skip" }
  | { kind: "message"; text: string }
  | { kind: "function_call"; call: Record<string, unknown> }
  | { kind: "unmodelled" };

/**
 * How a server output item relates to what the client will echo back next turn.
 *
 * `reasoning` and `web_search_call` are "skip": the client never replays either one (reasoning
 * is dropped by toResponsesInput; a web_search_call is never surfaced to Claude Code as a
 * replayable block), so both are simply absent from the baseline rather than invalidating it --
 * the server's own connection-local state still carries them via previous_response_id. `message`
 * and `function_call` are "modelled": the caller groups every item in a turn into the shape the
 * client actually rebuilds an assistant turn as (ALL text joined into ONE `message` item,
 * followed by ALL `function_call` items in order -- see toResponsesInput), which is why this
 * returns raw text/call fragments rather than a finished canon per item.
 *
 * "unmodelled" is not the same as "skip": the caller invalidates the whole baseline on an
 * unmodelled item, because guessing wrong here would splice a delta onto a context that does not
 * match and produce a subtly wrong conversation. Skipping costs one full resend; guessing costs
 * correctness. Keep genuinely unknown future item types unmodelled -- only reasoning and
 * web_search_call are known to be never echoed.
 */
function classifyOutputItem(item: Record<string, unknown>): OutputClassification {
  const type = item.type as string | undefined;
  if (type === "reasoning" || type === "web_search_call") return { kind: "skip" };
  if (type === "function_call") {
    return {
      kind: "function_call",
      call: {
        type: "function_call",
        call_id: item.call_id,
        name: item.name,
        arguments: item.arguments,
      },
    };
  }
  if (type === "message") {
    const content = (item.content as Array<{ type?: string; text?: string }> | undefined) ?? [];
    const text = content
      .filter((p) => p.type === "output_text" || p.type === "text")
      .map((p) => p.text ?? "")
      .join("");
    return { kind: "message", text };
  }
  return { kind: "unmodelled" };
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
  // `onerror` fires before `onclose` on a socket reset, so the turn is already told about the
  // drop (via onDrop, above) using onerror's reason before onclose's -- usually more informative
  // -- reason is even known. This lets a turn still waiting on that reason accept a better one
  // that arrives moments later, without re-running teardown or invoking onDrop a second time.
  // Deliberately NOT cleared by closeSession itself (unlike onFrame/onDrop): it must stay live
  // across the teardown that onDrop's first call triggers, and is cleared by the turn once the
  // reason has actually been consumed.
  onReasonUpgrade: ((reason: string) => void) | null;
};

const sessions: Session[] = [];
// Sockets that have been authorised to open but are not in `sessions` yet. Without this, two
// concurrent turns can both read `sessions.length` one below the cap, both pass the check, and
// both connect -- the cap is checked before an await and enforced after it.
let pendingConnects = 0;
let transportDisabled = false;
let disabledReason = "";

function closeSession(s: Session, reason: string) {
  if (s.closed) {
    // Teardown already ran -- most commonly onerror firing a moment before onclose, whose
    // `closed code=... reason=...` names the actual failure where onerror's was a generic
    // fallback literal. Do not repeat any teardown side effect (the socket is already closed,
    // already spliced out of `sessions`, and onDrop must not fire twice); just let a turn that
    // has not yet consumed the first reason see this better one instead.
    const upgrade = s.onReasonUpgrade;
    if (upgrade) upgrade(reason);
    return;
  }
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

// Fix A: an `error` frame naming one of these is an ordinary upstream refusal (plan quota,
// replica overload), not a transport fault. It must fail this turn over to HTTPS exactly like
// an expired `previous_response_id` already does, without disabling the socket for the rest of
// the process -- disabling it here is what turned one quota hit into 1,993/2,043 turns
// re-uploading the full transcript in production. Genuine transport faults (connect failure,
// socket close, protocol error) are not in this set and keep disabling as before.
const NON_TRANSPORT_UPSTREAM_ERROR_TYPES = new Set([
  "usage_limit_reached",
  "server_is_overloaded",
  "service_unavailable_error",
]);

/**
 * Prefers the parsed error frame's `type`/`code` field over a substring match: a structured
 * field that does not name one of these is trusted over falling through to the regex, since
 * the regex is a fallback for a frame that has no structured field to read at all.
 */
function isNonTransportUpstreamRefusal(errType: unknown, errCode: unknown, raw: string): boolean {
  const type = typeof errType === "string" ? errType : undefined;
  const code = typeof errCode === "string" ? errCode : undefined;
  if (type !== undefined || code !== undefined) {
    return (
      (type !== undefined && NON_TRANSPORT_UPSTREAM_ERROR_TYPES.has(type)) ||
      (code !== undefined && NON_TRANSPORT_UPSTREAM_ERROR_TYPES.has(code))
    );
  }
  return /usage_limit_reached|server_is_overloaded|service_unavailable_error/i.test(raw);
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

// The undici `ErrorEvent` handed to `onerror` carries `.message` (a generic library string, e.g.
// "websocket error") and, separately, `.error` -- sometimes the actual exception, with
// `code`/`errno`/`syscall` (ECONNRESET, ETIMEDOUT, UND_ERR_SOCKET, ...). It is not reliably that,
// though: measured on this host's Node v24 built-in undici, both a refused connect and an abrupt
// mid-connection RST hand `.error` a bare `TypeError` with an empty `.message` and none of those
// fields -- mining it blindly would print the unhelpful "TypeError" in place of the old, already
// -unhelpful-but-at-least-consistent "websocket error" literal. So this only prefers `.error` (or
// one level into `.error.cause`, where undici sometimes nests the real errno'd cause) over the
// `.message` fallback when it actually carries something the fallback lacks: a `code`/`errno`
// /`syscall`, or a non-empty `.message` of its own.
function describeSocketError(ev: { message?: string; error?: unknown } | null | undefined): string {
  const fallback = ev?.message ? String(ev.message) : "websocket error";
  const candidates = [ev?.error, (ev?.error as { cause?: unknown } | undefined)?.cause];
  for (const err of candidates) {
    if (!err || typeof err !== "object") continue;
    const e = err as { name?: unknown; message?: unknown; code?: unknown; errno?: unknown; syscall?: unknown };
    const detail: string[] = [];
    if (typeof e.code === "string" || typeof e.code === "number") detail.push(`code=${e.code}`);
    if (typeof e.errno === "string" || typeof e.errno === "number") detail.push(`errno=${e.errno}`);
    if (typeof e.syscall === "string" && e.syscall) detail.push(`syscall=${e.syscall}`);
    const hasMessage = typeof e.message === "string" && e.message.length > 0;
    if (!detail.length && !hasMessage) continue; // a bare constructor name is not an improvement
    const head: string[] = [];
    if (typeof e.name === "string" && e.name) head.push(e.name);
    if (hasMessage) head.push(e.message as string);
    if (detail.length) head.push(`(${detail.join(" ")})`);
    return head.join(": ");
  }
  return fallback;
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
      onReasonUpgrade: null,
    };

    socket.onopen = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(session);
    };
    socket.onerror = (ev) => {
      const message = describeSocketError(ev);
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

// Fix E: findResumable returning null used to mean the caller only ever logged "ws turn full",
// with no way to tell which of the four independent causes (see the file header) was at fault
// this time. Off by default -- CCX_CODEX_WS_DIAG=1 to enable, no code edit needed -- because it
// walks and truncated-stringifies every pooled baseline, which is wasted work on the hot path
// once the cause is already known.
function isWsResumeDiagEnabled(): boolean {
  const raw = process.env.CCX_CODEX_WS_DIAG;
  if (!raw) return false;
  const v = raw.trim().toLowerCase();
  return v === "1" || v === "true" || v === "on";
}

/** The pooled session sharing the longest common item prefix with this request, if any. */
function bestCandidateSession(itemCanons: string[]): Session | null {
  let best: Session | null = null;
  let bestScore = -1;
  for (const s of sessions) {
    if (!s.baseline) continue;
    const base = s.baseline.items;
    let common = 0;
    const max = Math.min(base.length, itemCanons.length);
    while (common < max && base[common] === itemCanons[common]) common += 1;
    if (common > bestScore) {
      bestScore = common;
      best = s;
    }
  }
  return best;
}

/** Names why the best candidate session was not resumable: shell match, lengths, first
 * divergent index, and a truncated canon of both sides at that index. */
function logResumeDiagnostic(itemCanons: string[], shell: string) {
  if (!isWsResumeDiagEnabled()) return;
  const candidate = bestCandidateSession(itemCanons);
  if (!candidate || !candidate.baseline) {
    console.log(`[codex] ws resume-diag: no pooled session has a baseline (pool size ${sessions.length})`);
    return;
  }
  const base = candidate.baseline;
  const shellMatch = base.shell === shell;
  const max = Math.min(base.items.length, itemCanons.length);
  let divergeAt = -1;
  for (let i = 0; i < max; i++) {
    if (base.items[i] !== itemCanons[i]) {
      divergeAt = i;
      break;
    }
  }
  if (divergeAt === -1 && base.items.length !== itemCanons.length) divergeAt = max;
  const trunc = (s: string | undefined) => (s === undefined ? "<end>" : s.slice(0, 200));
  console.log(
    `[codex] ws resume-diag: shellMatch=${shellMatch} baselineLen=${base.items.length} requestLen=${itemCanons.length} divergeAt=${divergeAt} baseline@div=${trunc(base.items[divergeAt])} request@div=${trunc(itemCanons[divergeAt])}`,
  );
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
  const itemCanons = params.input.map((item) => canonItem(item as unknown as Record<string, unknown>));

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

  if (!incremental) logResumeDiagnostic(itemCanons, shell);

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
  // Rebuilt as the response streams; committed to the session only at response.completed. Held
  // as text/function_call buffers rather than a flat item list -- see classifyOutputItem's doc
  // comment for why they are grouped this way before being canonicalized (Fix C).
  let echoHasMessage = false;
  const echoTexts: string[] = [];
  const echoCalls: Record<string, unknown>[] = [];
  let baselineUsable = true;
  // Set when an `error` frame names an ordinary upstream refusal rather than a transport fault
  // (Fix A) -- read after the first-frame wait below to decide whether to disable the transport.
  let nonTransportReason = false;
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
  // Lets closeSession hand this turn a better reason after onDrop already fired with a worse
  // one (see the doc comment on Session.onReasonUpgrade). Deliberately an UPGRADE, never a
  // creation: it only overwrites an already-set `failure`, never sets one from null. A turn can
  // also reach `finished` via `response.completed` (below) with `failure` left null -- onDrop's
  // own `if (finished) return` guard keeps that turn's failure null even if the socket then
  // errors or closes on the way down, and this hook must preserve that: writing into `failure`
  // unconditionally here would turn a turn that already completed successfully into a thrown
  // abort merely because the socket's teardown produced two events instead of one.
  active.onReasonUpgrade = (reason) => {
    if (failure !== null) failure = reason;
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
      const errObj = ev.error as Record<string, unknown> | undefined;
      nonTransportReason = isNonTransportUpstreamRefusal(errObj?.type, errObj?.code, raw);
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
        const cls = classifyOutputItem(item);
        if (cls.kind === "unmodelled") baselineUsable = false;
        else if (cls.kind === "message") {
          echoHasMessage = true;
          echoTexts.push(cls.text);
        } else if (cls.kind === "function_call") {
          echoCalls.push(cls.call);
        }
        // cls.kind === "skip" (reasoning, web_search_call): never echoed back by the client,
        // absent from the baseline, chain preserved -- the server's own connection-local state
        // still carries it via previous_response_id.
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
    active.onReasonUpgrade = null;
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
    active.onReasonUpgrade = null;
    const reason = failure ?? "no first frame";
    closeSession(active, reason);
    // An expired chain (server dropped its connection-local cache) or an ordinary upstream
    // refusal (Fix A: quota, overload) is a normal consequence of talking to a shared backend
    // and must not disable the transport; a genuine transport fault -- connect failure, socket
    // close, protocol error -- should.
    if (/previous_response_id/i.test(reason)) {
      console.log(`[codex] ws chain expired (${reason.slice(0, 120)}) - resending in full over HTTPS`);
    } else if (nonTransportReason) {
      console.log(
        `[codex] ws turn refused by upstream (${reason.slice(0, 120)}) - resending in full over HTTPS, transport stays enabled`,
      );
    } else {
      disableTransport(reason);
    }
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
        // Fix C: group into the shape the client will actually rebuild -- ALL text from this
        // turn joined into ONE `message` item, then the `function_call` items in order -- rather
        // than one echo entry per server output item. See classifyOutputItem's doc comment.
        const serverEcho: string[] = [];
        if (echoHasMessage) {
          serverEcho.push(
            canon({ type: "message", role: "assistant", content: [{ type: "output_text", text: echoTexts.join("") }] }),
          );
        }
        for (const call of echoCalls) serverEcho.push(canonItem(call));
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
      active.onReasonUpgrade = null;
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
