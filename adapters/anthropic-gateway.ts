// Main Fastify server that routes requests by provider prefix
import Fastify from "fastify";
import type { FastifyReply } from "fastify";
import { parseProviderModel, warnIfTools, userShortcutDefined } from "./map.js";
import type { AnthropicRequest, ProviderModel } from "./types.js";
import { chatOpenRouter } from "./providers/openrouter.js";
import { chatDeepSeek } from "./providers/deepseek.js";
import { chatClinePass } from "./providers/cline-pass.js";
import { chatGeminiOAuth } from "./providers/gemini-oauth.js";
import { chatCodexOAuth } from "./providers/codex-oauth.js";
import { passThrough } from "./providers/anthropic-pass.js";
import { preprocessImages } from "./vision-preprocess.js";
import { withAggregatedReply } from "./sse-aggregator.js";
import { applyNativeSearchSubstitution } from "./web-search-substitution.js";
import {
  buildLoginUrl,
  handleOAuthCallback,
  getLoginStatus,
  googleLogout,
  loginPage,
} from "./google-auth.js";
import {
  buildCodexLoginUrl,
  handleCodexOAuthCallback,
  getCodexLoginStatus,
  codexLogout,
  codexLoginPage,
} from "./openai-auth.js";
import { writePid, registerCleanup } from "../bin/lib/pid-manager.js";
import { recordFailure } from "./incident-log.js";
import { recordServed } from "./served-log.js";
import { fallbackChain, laneUnavailableReason } from "./fallbacks.js";
import { laneBelievedDown, laneDownSignalCount, laneHealth } from "./provider-health.js";
import { startLaneProbes } from "./lane-probe.js";
import { config } from "dotenv";
import { join } from "path";
import { homedir } from "os";
import { appendFileSync } from "fs";
import { createHash } from "crypto";

// Load .env from ~/.claude-proxy/.env
const envPath = join(homedir(), ".claude-proxy", ".env");
config({ path: envPath });

const directLogPath = process.env.CCX_DIRECT_LOG;
if (directLogPath) {
  const baseLog = console.log.bind(console);
  const baseError = console.error.bind(console);
  const formatArg = (arg: unknown) => {
    if (typeof arg === "string") return arg;
    if (arg instanceof Error) return arg.stack || arg.message;
    try {
      return JSON.stringify(arg);
    } catch {
      return String(arg);
    }
  };
  const append = (args: unknown[]) => {
    try {
      appendFileSync(directLogPath, `${args.map(formatArg).join(" ")}\n`);
    } catch {
      // Logging must never break the local proxy.
    }
  };
  console.log = (...args: unknown[]) => {
    append(args);
    baseLog(...args);
  };
  console.error = (...args: unknown[]) => {
    append(args);
    baseError(...args);
  };
}

// Escape untrusted values before interpolating them into HTML responses.
// The OAuth callback pages below render query parameters and upstream error
// text. Unescaped, any page in the browser can load these loopback endpoints
// with a crafted `error` parameter and execute script in this server's origin,
// which is same-origin with /v1/messages and therefore with the provider
// credentials this proxy attaches server-side.
function esc(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const PORT = Number(process.env.CLAUDE_PROXY_PORT || 17870);

// Support default provider from CLI commands (claude-codex, claude-gemini)
const defaultProvider = process.env.CCX_DEFAULT_PROVIDER as import("./types.js").ProviderKey | undefined;
const defaultModel = process.env.CCX_DEFAULT_MODEL;

let active: ProviderModel | null = defaultProvider && defaultModel
  ? { provider: defaultProvider, model: defaultModel }
  : null;

const fastify = Fastify({ logger: false, bodyLimit: 100 * 1024 * 1024 });


// startedAt captured at module load = process birth time
const startedAt = Date.now();

// Health check - returns pid + startedAt so CLI can cross-verify against PID lock
fastify.get("/healthz", async () => ({
  ok: true,
  pid: process.pid,
  startedAt,
  active: active ?? { provider: "glm", model: "auto" }
}));

// Status endpoint (shows current active provider/model)
fastify.get("/_status", async () => {
  return active ?? { provider: "glm", model: "glm-5" };
});

// ── Google OAuth endpoints ─────────────────────────────────────────────

// Landing page with sign-in button
fastify.get("/google/login", async (_req, reply) => {
  reply.type("text/html").send(loginPage(PORT));
});

// Start OAuth flow (redirects to Google)
fastify.get("/google/login/start", async (_req, reply) => {
  const authUrl = buildLoginUrl(PORT);
  reply.redirect(authUrl);
});

// OAuth callback (receives auth code from Google)
fastify.get("/google/callback", async (req, reply) => {
  const query = req.query as Record<string, string>;
  const { code, state, error } = query;

  if (error) {
    return reply.type("text/html").code(400).send(
      `<html><body style="font-family:system-ui;text-align:center;padding:60px;background:#0f172a;color:#e2e8f0;">
        <h1 style="color:#f87171;">Login Failed</h1><p>${esc(error)}</p>
        <a href="/google/login" style="color:#60a5fa;">Try again</a>
      </body></html>`
    );
  }

  if (!code || !state) {
    return reply.type("text/html").code(400).send(
      `<html><body style="font-family:system-ui;text-align:center;padding:60px;background:#0f172a;color:#e2e8f0;">
        <h1 style="color:#f87171;">Missing Parameters</h1><p>No authorization code received.</p>
        <a href="/google/login" style="color:#60a5fa;">Try again</a>
      </body></html>`
    );
  }

  try {
    const tokens = await handleOAuthCallback(code, state);
    reply.type("text/html").send(
      `<html><body style="font-family:system-ui;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#0f172a;">
        <div style="text-align:center;color:#e2e8f0;max-width:500px;">
          <div style="font-size:48px;">&#10003;</div>
          <h1 style="color:#4ade80;">Authenticated Successfully</h1>
          <p>Logged in as: <strong>${esc(tokens.email || "unknown")}</strong></p>
          ${tokens.project_id ? `<p>Code Assist Project: <code style="background:#1e293b;padding:2px 8px;border-radius:4px;">${esc(tokens.project_id)}</code></p>` : `<p style="color:#94a3b8;">Using standard Generative Language API</p>`}
          <p style="color:#64748b;margin-top:24px;">You can close this window.<br>Use <code style="background:#1e293b;padding:2px 8px;border-radius:4px;">go:gemini-3.1-pro-preview</code> as your model in Claude Code.</p>
        </div>
      </body></html>`
    );
  } catch (e: any) {
    reply.type("text/html").code(500).send(
      `<html><body style="font-family:system-ui;text-align:center;padding:60px;background:#0f172a;color:#e2e8f0;">
        <h1 style="color:#f87171;">Login Failed</h1><p>${esc(e.message)}</p>
        <a href="/google/login" style="color:#60a5fa;">Try again</a>
      </body></html>`
    );
  }
});

// Login status
fastify.get("/google/status", async () => {
  return getLoginStatus();
});

// Logout
fastify.post("/google/logout", async () => {
  await googleLogout();
  return { ok: true, message: "Logged out of Google" };
});

// ── Google Account 2 OAuth endpoints (failover account) ────────────────

// Landing page for account 2
fastify.get("/google/login/2", async (_req, reply) => {
  reply.type("text/html").send(loginPage(PORT, 2));
});

// Start OAuth flow for account 2
fastify.get("/google/login/2/start", async (_req, reply) => {
  const authUrl = buildLoginUrl(PORT, 2);
  reply.redirect(authUrl);
});

// OAuth callback for account 2
fastify.get("/google/callback/2", async (req, reply) => {
  const query = req.query as Record<string, string>;
  const { code, state, error } = query;

  if (error) {
    return reply.type("text/html").code(400).send(
      `<html><body style="font-family:system-ui;text-align:center;padding:60px;background:#0f172a;color:#e2e8f0;">
        <h1 style="color:#f87171;">Login Failed</h1><p>${esc(error)}</p>
        <a href="/google/login/2" style="color:#60a5fa;">Try again</a>
      </body></html>`
    );
  }

  if (!code || !state) {
    return reply.type("text/html").code(400).send(
      `<html><body style="font-family:system-ui;text-align:center;padding:60px;background:#0f172a;color:#e2e8f0;">
        <h1 style="color:#f87171;">Missing Parameters</h1><p>No authorization code received.</p>
        <a href="/google/login/2" style="color:#60a5fa;">Try again</a>
      </body></html>`
    );
  }

  try {
    const tokens = await handleOAuthCallback(code, state, 2);
    reply.type("text/html").send(
      `<html><body style="font-family:system-ui;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#0f172a;">
        <div style="text-align:center;color:#e2e8f0;max-width:500px;">
          <div style="font-size:48px;">&#10003;</div>
          <h1 style="color:#4ade80;">Failover Account Linked</h1>
          <p>Account 2 logged in as: <strong>${esc(tokens.email || "unknown")}</strong></p>
          ${tokens.project_id ? `<p>Code Assist Project: <code style="background:#1e293b;padding:2px 8px;border-radius:4px;">${esc(tokens.project_id)}</code></p>` : `<p style="color:#94a3b8;">Using standard Generative Language API</p>`}
          <p style="color:#64748b;margin-top:24px;">You can close this window.<br>This account will be used automatically when account 1 hits rate limits.</p>
        </div>
      </body></html>`
    );
  } catch (e: any) {
    reply.type("text/html").code(500).send(
      `<html><body style="font-family:system-ui;text-align:center;padding:60px;background:#0f172a;color:#e2e8f0;">
        <h1 style="color:#f87171;">Login Failed</h1><p>${esc(e.message)}</p>
        <a href="/google/login/2" style="color:#60a5fa;">Try again</a>
      </body></html>`
    );
  }
});

// Account 2 login status
fastify.get("/google/status/2", async () => {
  return getLoginStatus(2);
});

// Account 2 logout
fastify.post("/google/logout/2", async () => {
  await googleLogout(2);
  return { ok: true, message: "Logged out of Google account 2" };
});

// ── OpenAI/Codex OAuth endpoints ──────────────────────────────────────

// Landing page with sign-in button
fastify.get("/codex/login", async (_req, reply) => {
  reply.type("text/html").send(codexLoginPage());
});

// Start OAuth flow (redirects to OpenAI)
fastify.get("/codex/login/start", async (_req, reply) => {
  const authUrl = buildCodexLoginUrl(PORT);
  reply.redirect(authUrl);
});

// OAuth callback (receives auth code from OpenAI)
fastify.get("/codex/callback", async (req, reply) => {
  const query = req.query as Record<string, string>;
  const { code, state, error } = query;

  if (error) {
    return reply.type("text/html").code(400).send(
      `<html><body style="font-family:system-ui;text-align:center;padding:60px;background:#0f172a;color:#e2e8f0;">
        <h1 style="color:#f87171;">Login Failed</h1><p>${esc(error)}</p>
        <a href="/codex/login" style="color:#60a5fa;">Try again</a>
      </body></html>`
    );
  }

  if (!code || !state) {
    return reply.type("text/html").code(400).send(
      `<html><body style="font-family:system-ui;text-align:center;padding:60px;background:#0f172a;color:#e2e8f0;">
        <h1 style="color:#f87171;">Missing Parameters</h1><p>No authorization code received.</p>
        <a href="/codex/login" style="color:#60a5fa;">Try again</a>
      </body></html>`
    );
  }

  try {
    const tokens = await handleCodexOAuthCallback(code, state);
    reply.type("text/html").send(
      `<html><body style="font-family:system-ui;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#0f172a;">
        <div style="text-align:center;color:#e2e8f0;max-width:500px;">
          <div style="font-size:48px;">&#10003;</div>
          <h1 style="color:#4ade80;">OpenAI Authenticated</h1>
          <p>Logged in as: <strong>${esc(tokens.email || "unknown")}</strong></p>
          <p>Plan: <strong style="color:#a78bfa;">${esc(tokens.plan || "unknown")}</strong></p>
          <p style="color:#64748b;margin-top:24px;">You can close this window.<br>Use <code style="background:#1e293b;padding:2px 8px;border-radius:4px;">codex</code> as your model in Claude Code.</p>
        </div>
      </body></html>`
    );
  } catch (e: any) {
    reply.type("text/html").code(500).send(
      `<html><body style="font-family:system-ui;text-align:center;padding:60px;background:#0f172a;color:#e2e8f0;">
        <h1 style="color:#f87171;">Login Failed</h1><p>${esc(e.message)}</p>
        <a href="/codex/login" style="color:#60a5fa;">Try again</a>
      </body></html>`
    );
  }
});

// Codex login status
fastify.get("/codex/status", async () => {
  return getCodexLoginStatus();
});

// Codex logout
fastify.post("/codex/logout", async () => {
  await codexLogout();
  return { ok: true, message: "Logged out of OpenAI" };
});

// -- Auto-mode permission classifier -----------------------------------------
//
// Claude Code's auto mode adjudicates each tool call with a separate model request. There is
// no setting for which model that is: the docs say outright that "Claude Code selects the
// classifier model", and the `autoMode` settings block carries only rule lists. That matters
// when an Anthropic subscription is exhausted, because the classifier fails CLOSED -- a
// blocked classifier call denies the action, so auto mode stops working entirely while the
// session is otherwise happily answering from another provider.
//
// The one client-side lever that does reach it, ANTHROPIC_DEFAULT_SONNET_MODEL, reaches it by
// repointing the whole Sonnet slot, and measurably costs the classifier its request shaping:
// with a model string Claude Code does not recognise it stops sending
// `thinking: {type:"disabled"}` (observed on the wire: in:think went disabled -> unset), and
// that flag is a deliberate latency optimisation for routine checks. Matching on the SHAPE
// instead leaves the client's own model string and body untouched, so the shaping survives
// and only the destination moves.
//
// Every clause below was read off real requests in proxy.log, not guessed:
//   claude-sonnet-*    the documented default classifier model
//   claude-opus-*      the documented fallback -- see CLASSIFIER_MODELS
//   thinking disabled  the client's own optimisation, and the tightest discriminator here
//   no tools           an adjudication, never a tool-using turn
//   exactly 2 messages the action under review plus its context
//   non-streaming      the caller wants one verdict, not a token stream
//
// Fails safe in both directions. An unmatched request routes exactly as before, so a Claude
// Code update that changes the shape degrades to today's behaviour rather than to a wrong
// model. And a matched request still needs the alias to exist, so this is inert until someone
// deliberately defines it.
const CLASSIFIER_ALIAS = "classifier";

// Sonnet is the default; Opus is not an alternative spelling of it but a documented FALLBACK,
// and the reason to accept it here is that the fallback is the expensive case. Per
// permission-modes.md the classifier runs on Sonnet 5 "rather than on your /model selection",
// except that it runs "on an Opus model when the session runs on Fable 5". So a Fable session
// silently adjudicates every tool call on Opus.
//
// Matching Sonnet alone -- which this did at first -- left exactly that case unroutable, which
// is backwards: it is the one where moving the classifier is worth most, both for cost and
// because Sonnet is a perfectly good adjudicator.
//
// Widening the model clause does not widen the match much, because the shape clauses below do
// the real work. A Claude Code main-loop request on Opus carries tools, many messages, streams,
// and asks for thinking; it fails four clauses, not one.
const CLASSIFIER_MODELS = /^claude-(sonnet|opus)/i;

function isPermissionClassifier(body: any): boolean {
  return (
    typeof body?.model === "string" &&
    CLASSIFIER_MODELS.test(body.model) &&
    body?.thinking?.type === "disabled" &&
    (!body?.tools || body.tools.length === 0) &&
    body?.messages?.length === 2 &&
    !!body?.system &&
    body?.stream !== true
  );
}

// Main messages endpoint - routes by model prefix
fastify.post("/v1/messages", async (req, res) => {
  // Set as soon as the provider is resolved, so the catch block below can attribute a failure
  // to the lane that produced it even though `provider` itself is scoped to the try block.
  let attemptedLane: string | undefined;
  try {
    const body = req.body as AnthropicRequest;
    const defaults = active ?? undefined;
    // Resolve against the alias rather than the client's string when this is a classifier
    // request AND the user has defined somewhere to send it. body.model is deliberately left
    // alone: it is logged below as what the client asked for, and rewriting it would erase the
    // only evidence that the reroute happened.
    const rerouted =
      isPermissionClassifier(body) && userShortcutDefined(CLASSIFIER_ALIAS);
    const modelField = rerouted ? CLASSIFIER_ALIAS : body.model;
    let { provider, model, reasoning, serviceTier } = parseProviderModel(modelField, defaults);

    // Fallback chain for this alias (fallbacks.ts). The pristine copy is taken BEFORE any
    // adapter prep below mutates the body, so every later hop starts from what the client
    // sent. `displayModel` is what the primary would have echoed; a hop rewrites its reply's
    // model field to it so the client sees the same name whichever target answered.
    const chainTargets = fallbackChain(modelField).map((t) => ({
      spec: t,
      target: parseProviderModel(t, defaults),
    }));
    const pristineBody = chainTargets.length ? structuredClone(body) : undefined;
    const displayModel = model;
    const primarySpec = `${provider}:${model}`;
    let chainIdx = -1; // -1 = primary, n = chainTargets[n]
    if (chainTargets.length && laneBelievedDown(provider)) {
      // (1) Primary's lane is known down with no reset in the past: don't spend a request
      // proving it again. Skip to the first target whose lane is not down; if every lane in
      // the chain is down, try the primary anyway rather than failing without an attempt.
      const firstUp = chainTargets.findIndex((c) => !laneBelievedDown(c.target.provider));
      if (firstUp !== -1) {
        const rec = laneHealth(provider);
        console.log(
          `[fallback] ${modelField}: ${primarySpec} -> ${chainTargets[firstUp].spec} (primary lane down: ${rec?.reason || "down"})`,
        );
        chainIdx = firstUp;
        ({ provider, model, reasoning, serviceTier } = chainTargets[firstUp].target);
      }
    }
    attemptedLane = provider;

    // Log every request for debugging
    const tools = body.tools?.map((t: any) => t.name).join(",") || "none";
    const hasSystem = !!body.system;
    const msgCount = body.messages?.length || 0;
    // What the CLIENT asked for, before any adapter rewrites it. Without this there is no
    // way to tell a model that chose not to think from a client that never turned thinking
    // on - the two are identical downstream, and only one of them is worth changing.
    const inThink = (body as any).thinking?.type ?? "unset";
    const inEffort = (body as any).output_config?.effort;
    // Context-management strategies travel with thinking: `clear_thinking_*` is valid only
    // while thinking is enabled, so the pair is what determines whether a body is coherent.
    // Logging thinking alone showed a 400 without showing why.
    const inEdits = ((body as any).context_management?.edits ?? [])
      .map((e: any) => e?.type)
      .filter(Boolean)
      .join("+");
    const inbound =
      ` in:think=${inThink}${inEffort ? `,effort=${inEffort}` : ""}${inEdits ? `,ctx=${inEdits}` : ""}`;
    // The reroute is named in the log rather than inferred from the resolved model. A silent
    // rewrite of which model adjudicates permission decisions is precisely the thing that must
    // never be silent -- and without this the line would read as though the client itself had
    // asked for the classifier alias.
    const via = rerouted ? ` via=${CLASSIFIER_ALIAS}` : "";
    // serviceTier is logged here as INTENT — what the alias asked for. Whether it actually
    // reached the wire is the adapter's line to print, because only the adapter knows whether
    // the model supports it. Reading this field as proof that fast mode was billed is the same
    // mistake as reading `in:effort` as proof of the effort the model ran at.
    console.log(`[ccx] REQUEST: model="${body.model}"${via} → provider="${provider}" model="${model}"${reasoning ? ` reasoning=${reasoning}` : ""}${serviceTier ? ` serviceTier=${serviceTier}` : ""}${inbound} | tools=[${tools}] system=${hasSystem} messages=${msgCount} stream=${body.stream === true ? "true" : "false"}`);

    recordServed({
      requested: body.model, provider, model, reasoning, serviceTier, inEffort,
      stream: body.stream === true, headers: req.headers as Record<string, unknown>,
      rerouted, fallbackHop: chainIdx,
    });

    // Claude Code 2.1.268's server-side threads ("tether") send only the NEW messages on a
    // continue, trusting the server to already hold the earlier turns. Only the real Anthropic
    // API holds that state; every other backend here is stateless, so a continue arrives missing
    // the tool_use that its tool_result answers, and upstream 400s. Rather than reconstructing
    // history ourselves, decline the thread the way Claude Code already knows how to handle: it
    // has a built-in negotiation that, on seeing error_code "thread_unsupported_request", resends
    // this same turn with the full transcript and falls back to stateless FOR THIS MODEL ONLY -
    // leaving threading intact for other models, including the anthropic lane.
    if (provider !== "anthropic" && (body as any).thread) {
      console.log(`[ccx] thread declined: provider="${provider}" model="${model}" thread=${(body as any).thread?.type} - client will resend stateless`);
      return sendThreadDeclined(res);
    }

    // Warn if using tools with providers that may not support them
    warnIfTools(body, provider);

    // For codex, openai, and gemini providers with native web search, strip Claude's
    // web tools and inject a system prompt telling the model to use its own search.
    // Claude Code's WebSearch runs locally and won't work through the proxy.
    const hasNativeSearch = ["codex-oauth", "openai", "gemini-oauth", "gemini"].includes(provider);
    if (hasNativeSearch) {
      // P0.1 - capture the INBOUND system representation before applyNativeSearchSubstitution
      // mutates it (it appends a fixed 445-char searchNote to the end for codex - constant,
      // so it cannot be the 1,432-char swing or a prefix breaker Phase 0 is hunting for). This
      // is diagnostic only: hashes, lengths and counts, never block contents. cch is a
      // per-request 5-hex stamp Claude Code inserts into the metadata line and must never be
      // logged by value - only whether it's present and how long it is.
      try {
        const sys = body.system;
        const blocks: { index: number; type: string; len: number; hash: string }[] = [];
        let flat = "";
        if (typeof sys === "string") {
          blocks.push({
            index: 0,
            type: "string",
            len: sys.length,
            hash: createHash("sha1").update(sys).digest("hex").slice(0, 12),
          });
          flat = sys;
        } else if (Array.isArray(sys)) {
          sys.forEach((block, index) => {
            const text = typeof block?.text === "string" ? block.text : "";
            blocks.push({
              index,
              type: typeof block?.type === "string" ? block.type : "unknown",
              len: text.length,
              hash: createHash("sha1").update(text).digest("hex").slice(0, 12),
            });
          });
          flat = sys.map((b) => (typeof b?.text === "string" ? b.text : "")).join("\n");
        }
        const promptIdMatch = flat.match(/cc_prompt_id=([0-9a-f-]{36})/);
        const cchMatch = flat.match(/cch=([0-9a-f]{5})/);
        const blockSummary = blocks
          .map((b) => `[${b.index}]${b.type}:len=${b.len},hash=${b.hash}`)
          .join(" ");
        console.log(
          `[codex] p0-system kind=${typeof sys === "string" ? "string" : Array.isArray(sys) ? "array" : "none"} blocks=${blocks.length} cc_prompt_id=${promptIdMatch ? promptIdMatch[1] : "absent"} cch=${cchMatch ? `present(${cchMatch[1].length})` : "absent"} ${blockSummary}`,
        );
      } catch (err) {
        console.log(`[codex] p0-system error=${err instanceof Error ? err.message : String(err)}`);
      }
      applyNativeSearchSubstitution(body, provider);
    }

    // Don't let internal Claude Code requests (haiku for titles, etc.) override the user's active model
    if (provider !== "anthropic") {
      active = { provider, model };
    }

    // Every `return` below is `return await`, deliberately. A bare `return p`
    // inside this try block does NOT route p's rejection to the catch at the
    // bottom - so an upstream error thrown mid-stream escaped the handler
    // entirely, took the `res.raw.headersSent` guard with it, and reached
    // Fastify's fallback error handler, which called writeHead on a response
    // whose SSE headers were already flushed. That throws ERR_HTTP_HEADERS_SENT
    // from a microtask with nothing to catch it, and the proxy process exits -
    // every session then sees ECONNREFUSED on this port. One DeepSeek 400 was
    // enough to do it. The awaits are what keep a bad upstream response a bad
    // response instead of an outage.

    // Anthropic's convention: only stream when `stream: true` is explicitly set.
    // Omitted or false = single JSON response. Claude Code's /model validation probe
    // omits the field entirely and sends `Accept: application/json`, so it has to
    // get one JSON message back — not SSE chunks.
    const wantsStream = body.stream === true;

    // One target's worth of the provider dispatch below. Its parameters deliberately shadow
    // the outer provider/model/reasoning/serviceTier/body, so the branches read exactly as
    // they did before fallback chains existed; the outer names are only the first target.
    const dispatch = async (
      { provider, model, reasoning, serviceTier }: ProviderModel,
      body: AnthropicRequest,
      attempt: AttemptState,
    ): Promise<unknown> => {
    // Codex renders its own errors into the reply; while a fallback is armed and nothing has
    // reached the client, it rethrows instead so the chain below can move on.
    const codexFallbackArmed = () => attempt.armed && !res.raw.headersSent && !attempt.wrote;
    const runStreaming = async (handler: (r: typeof res) => Promise<unknown>) => {
      if (wantsStream) {
        res.raw.setHeader("Content-Type", "text/event-stream");
        res.raw.setHeader("Cache-Control", "no-cache, no-transform");
        res.raw.setHeader("Connection", "keep-alive");
        // Held back while a fallback is armed: once headers are on the wire the reply is
        // committed to this target, and a lane failure before the first byte could no longer
        // hand over to the next one. The first write flushes them either way.
        // @ts-ignore
        if (!attempt.armed) res.raw.flushHeaders?.();
        return handler(res);
      }
      return withAggregatedReply(res, (bufRes) => {
        if (attempt.armed) {
          // The buffered reply never sets headersSent, so record "output started" here.
          const raw = bufRes.raw as any;
          const write = raw.write.bind(raw);
          raw.write = (chunk: unknown) => {
            attempt.wrote = true;
            return write(chunk);
          };
        }
        return handler(bufRes as typeof res);
      });
    };

    // Validate API keys BEFORE setting headers
    if (provider === "openai") {
      const key = process.env.OPENAI_API_KEY;
      if (!key) {
        throw apiError(401, "OPENAI_API_KEY not set in ~/.claude-proxy/.env");
      }
      return await runStreaming((r) => chatCodexOAuth(r, body, model, key, reasoning, serviceTier, codexFallbackArmed));
    }

    if (provider === "openrouter") {
      const key = process.env.OPENROUTER_API_KEY;
      if (!key) {
        throw apiError(401, "OPENROUTER_API_KEY not set in ~/.claude-proxy/.env");
      }
      return await runStreaming((r) => chatOpenRouter(r, body, model, key, reasoning));
    }

    if (provider === "deepseek") {
      const key = process.env.DEEPSEEK_API_KEY;
      if (!key) {
        throw apiError(401, "DEEPSEEK_API_KEY not set in ~/.claude-proxy/.env");
      }
      return await runStreaming((r) => chatDeepSeek(r, body, model, key, reasoning));
    }

    if (provider === "cline-pass") {
      return await runStreaming((r) => chatClinePass(r, body, model, reasoning));
    }

    if (provider === "gemini-oauth") {
      return await runStreaming((r) => chatGeminiOAuth(r, body, model, undefined, reasoning));
    }

    if (provider === "codex-oauth") {
      return await runStreaming((r) => chatCodexOAuth(r, body, model, undefined, reasoning, serviceTier, codexFallbackArmed));
    }

    if (provider === "gemini") {
      const key = process.env.GEMINI_API_KEY;
      if (!key) {
        throw apiError(401, "GEMINI_API_KEY not set in ~/.claude-proxy/.env");
      }
      return await runStreaming((r) => chatGeminiOAuth(r, body, model, key, reasoning));
    }

    if (provider === "anthropic") {
      const base = process.env.ANTHROPIC_UPSTREAM_URL || "https://api.anthropic.com";
      const key = process.env.ANTHROPIC_API_KEY;
      const inbound = req.headers as Record<string, string | undefined>;

      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "anthropic-version":
          inbound["anthropic-version"] || process.env.ANTHROPIC_VERSION || "2023-06-01",
      };

      if (key) {
        // Explicitly configured API key wins.
        headers["x-api-key"] = key;
      } else {
        // Otherwise forward the caller's own Anthropic credentials. A Claude
        // Code client signed in on a subscription sends an OAuth bearer token
        // plus an anthropic-beta feature list (including oauth-2025-04-20,
        // which is what authorizes that token). Substituting a server-side
        // x-api-key here would silently bypass the subscription and bill the
        // user per token instead - so when no key is configured, relay what
        // the client sent and let the upstream authenticate it directly.
        for (const h of ["authorization", "x-api-key", "anthropic-beta", "x-app", "user-agent"]) {
          const v = inbound[h];
          if (v) headers[h] = v;
        }
        if (!headers["authorization"] && !headers["x-api-key"]) {
          throw apiError(
            401,
            "No Anthropic credentials. Either sign in to Claude Code (its Authorization header is forwarded) or set ANTHROPIC_API_KEY in ~/.claude-proxy/.env"
          );
        }
      }

      return await passThrough({
        res,
        body,
        model,
        baseUrl: base,
        headers,
        stream: wantsStream,
        // The @suffix already parsed above. Passed only on the Anthropic branch: GLM is
        // Anthropic-compatible in envelope but not in reasoning surface, so the same
        // translation there would send it fields it never agreed to.
        reasoning,
        // Same deferred-header contract as runStreaming: while a later hop exists, the SSE
        // headers go out with the first body byte, not on the upstream's 200.
        deferHeaders: attempt.armed,
      });
    }

    // Default: glm (Z.AI)
    const glmBase = process.env.GLM_UPSTREAM_URL;
    const glmKey = process.env.ZAI_API_KEY || process.env.GLM_API_KEY;
    if (!glmBase || !glmKey) {
      throw apiError(
        500,
        "GLM_UPSTREAM_URL and ZAI_API_KEY not set in ~/.claude-proxy/.env. Run: ccx --setup"
      );
    }
    // Convert images to text descriptions since GLM doesn't support vision
    await preprocessImages(body, process.env.OPENROUTER_API_KEY);
    // Don't set headers here - passThrough will do it after validation
    return await passThrough({
      res,
      body,
      model,
      baseUrl: glmBase,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${glmKey}`,
        "anthropic-version": process.env.ANTHROPIC_VERSION || "2023-06-01"
      },
      deferHeaders: attempt.armed,
    });
    };

    if (!chainTargets.length) {
      return await dispatch({ provider, model, reasoning, serviceTier }, body, { armed: false, wrote: false });
    }

    // (2) Walk the chain. A target that fails with a lane-unavailability error (the adapters'
    // own markLaneDown verdict, or a connection that never opened - see fallbacks.ts) BEFORE
    // anything reached the client hands over to the next target whose lane is not down. Once
    // a byte or a header is on the wire the reply belongs to that target and any later error
    // surfaces exactly as it would have without a chain.
    let current: ProviderModel = { provider, model, reasoning, serviceTier };
    let currentSpec = chainIdx === -1 ? primarySpec : chainTargets[chainIdx].spec;
    let attemptBody: AnthropicRequest = body;
    let rewriter: ModelRewriter | undefined;
    for (;;) {
      if (chainIdx !== -1 && !rewriter) rewriter = rewriteReplyModel(res.raw, displayModel);
      const nextIdx = chainTargets.findIndex(
        (c, j) => j > chainIdx && !laneBelievedDown(c.target.provider),
      );
      const attempt: AttemptState = { armed: nextIdx !== -1, wrote: false };
      const downSignalsBefore = laneDownSignalCount(current.provider);
      try {
        return await dispatch(current, attemptBody, attempt);
      } catch (e: any) {
        // Bytes held by the model rewriter were produced by THIS attempt: output has started.
        const untouched = !res.raw.headersSent && !attempt.wrote && !rewriter?.holding();
        const reason =
          attempt.armed && untouched
            ? laneUnavailableReason(current.provider, e, downSignalsBefore)
            : null;
        if (!reason) {
          // Release anything held so the error below lands after it, as an in-stream error.
          rewriter?.flush();
          throw e;
        }
        console.error(`[ccx] ERROR: ${e?.message || "proxy error"}`);
        recordFailure(current.provider, e?.message || "proxy error", e?.cause);

        const next = chainTargets[nextIdx];
        console.log(`[fallback] ${modelField}: ${currentSpec} -> ${next.spec} (${reason})`);
        // A failed attempt may have staged headers (anthropic-pass forwards the upstream's
        // rate-limit headers even on a 429); none of them describe the next target's reply.
        for (const h of res.raw.getHeaderNames()) res.raw.removeHeader(h);
        chainIdx = nextIdx;
        current = next.target;
        currentSpec = next.spec;
        attemptedLane = current.provider;
        attemptBody = structuredClone(pristineBody!);
        // The per-target prep the primary got above, for this target.
        if (current.provider !== "anthropic" && (attemptBody as any).thread) {
          console.log(`[ccx] thread declined: provider="${current.provider}" model="${current.model}" thread=${(attemptBody as any).thread?.type} - client will resend stateless`);
          return sendThreadDeclined(res);
        }
        warnIfTools(attemptBody, current.provider);
        if (["codex-oauth", "openai", "gemini-oauth", "gemini"].includes(current.provider)) {
          applyNativeSearchSubstitution(attemptBody, current.provider);
        }
        if (current.provider !== "anthropic") {
          active = { provider: current.provider, model: current.model };
        }
      }
    }
  } catch (e: any) {
    const status = e?.statusCode ?? 500;
    const msg = e?.message || "proxy error";
    console.error(`[ccx] ERROR: ${msg}`);
    // Every provider's failure surfaces here uniformly (thrown fetch() rejections and the
    // "Upstream error (status): body" the pass-through adapters raise for a non-2xx response
    // alike), which makes this the one place a transport refusal or an org-policy denial can be
    // classified and correlated regardless of which lane produced it. See incident-log.ts - a
    // failure that isn't one of those two classes is a no-op here.
    recordFailure(attemptedLane ?? "unknown", msg, e?.cause);

    // If SSE headers already sent, we can't send a JSON error - write error as SSE event
    if (res.raw.headersSent) {
      try {
        res.raw.write(`event: error\ndata: ${JSON.stringify({ type: "error", error: { type: "api_error", message: msg } })}\n\n`);
        res.raw.end();
      } catch { /* stream already closed */ }
      return;
    }
    return res.code(status).send({ error: msg });
  }
});

function sendThreadDeclined(res: FastifyReply) {
  return res.code(400).send({
    type: "error",
    error: {
      type: "invalid_request_error",
      message: "Server-side conversation threads are not supported for this model; resend the full transcript.",
      details: { error_code: "thread_unsupported_request" },
    },
  });
}

/** Per-attempt state for one target in a fallback chain. */
type AttemptState = {
  /** A later target exists, so a lane failure before output may still hand over. */
  armed: boolean;
  /** Something was written to a buffered (non-streaming) reply. */
  wrote: boolean;
};

/**
 * Make a fallback hop's reply carry the primary's model name. Every adapter's first `"model"`
 * key is the one the client reads: message_start's message.model on a stream (always the
 * first event), and the top-level model on a JSON body (it precedes `content`). Rewrites that
 * first occurrence once, then passes every later chunk through untouched.
 *
 * Upstream chunk boundaries are arbitrary (anthropic-pass forwards raw Uint8Array reads), so
 * bytes are HELD until a complete `"model":"..."` field has arrived, the first SSE event has
 * ended without one, or MAX_HOLD bytes pile up - then released as one write. Joining bytes
 * before decoding also keeps a multibyte character split across chunks intact.
 */
type ModelRewriter = { holding: () => boolean; flush: () => void };

function rewriteReplyModel(raw: any, displayModel: string): ModelRewriter {
  const re = /"model"\s*:\s*"(?:[^"\\]|\\.)*"/;
  const MAX_HOLD = 64 * 1024;
  let done = false;
  let held: Buffer[] = [];
  const write = raw.write.bind(raw);
  const end = raw.end.bind(raw);
  const toBuf = (c: any) => (typeof c === "string" ? Buffer.from(c, "utf8") : Buffer.from(c));

  // Returns the text to emit once the decision is made, or undefined to keep holding.
  const settle = (final: boolean): string | Buffer | undefined => {
    const buf = Buffer.concat(held);
    const text = buf.toString("utf8");
    if (re.test(text)) {
      done = true;
      held = [];
      return text.replace(re, `"model":${JSON.stringify(displayModel)}`);
    }
    // message_start is always the first SSE event, so once one event has fully arrived
    // without a model field there is nothing left to wait for.
    const firstEventEnded = text.includes("\n\n");
    if (final || firstEventEnded || buf.length >= MAX_HOLD) {
      done = true;
      held = [];
      return buf;
    }
    return undefined;
  };

  raw.write = (chunk: any, ...rest: any[]) => {
    if (done || chunk == null) return write(chunk, ...rest);
    held.push(toBuf(chunk));
    const out = settle(false);
    return out === undefined ? true : write(out, ...rest);
  };
  raw.end = (chunk?: any, ...rest: any[]) => {
    if (done) return end(chunk, ...rest);
    if (chunk != null && typeof chunk !== "function") held.push(toBuf(chunk));
    else if (typeof chunk === "function") rest.unshift(chunk);
    const out = settle(true);
    return out && out.length ? end(out, ...rest) : end(...rest);
  };
  return {
    holding: () => !done && held.length > 0,
    flush: () => {
      if (done || held.length === 0) return;
      const buf = Buffer.concat(held);
      done = true;
      held = [];
      write(buf);
    },
  };
}

function apiError(status: number, message: string) {
  const e = new Error(message);
  // @ts-ignore
  e.statusCode = status;
  return e;
}

registerCleanup();

// Last-resort backstop: keep serving when something escapes every per-request
// handler. Not a substitute for handling errors where they happen - the awaits
// in /v1/messages are the real fix for the failure we know about - but that one
// took the whole proxy down and cost every concurrent session its connection,
// so the ceiling on an unknown one of the same shape should not also be death.
//
// The class of fault this covers is per-request, not per-process: Fastify's
// fallback error handler calling writeHead on a response whose SSE headers were
// already flushed throws ERR_HTTP_HEADERS_SENT from a microtask with no owner.
// One request is lost; the server is entirely fine. Exiting there trades a
// dropped request for an outage, which is the worse of the two.
//
// Deliberately NOT a flood guard that exits after N errors. Nothing auto-restarts
// this process between logons, so "exit and let the supervisor handle it" has no
// supervisor to hand to - a noisy log while still serving beats a quiet dead port.
//
// Installed only after listen() resolves, so a genuine startup failure (a port
// already held, a bad config) still exits(1) through the .catch below rather than
// being swallowed into a proxy that is up but serving nothing.
function installLastResortHandlers() {
  process.on("uncaughtException", (err: Error) => {
    console.error(`[ccx] UNCAUGHT: ${err?.message || err}`);
    if (err?.stack) console.error(err.stack);
    console.error("[ccx] Proxy is still listening - the request that caused this was dropped.");
  });

  process.on("unhandledRejection", (reason: unknown) => {
    const err = reason as Error;
    console.error(`[ccx] UNHANDLED REJECTION: ${err?.message || String(reason)}`);
    if (err?.stack) console.error(err.stack);
    console.error("[ccx] Proxy is still listening - the request that caused this was dropped.");
  });
}

fastify
  .listen({ port: PORT, host: "127.0.0.1" })
  .then(async () => {
    installLastResortHandlers();
    await writePid();
    // Re-checks lanes marked down in provider-health.json (see lane-probe.ts).
    startLaneProbes();
    console.log(`[ccx] Proxy listening on http://127.0.0.1:${PORT} (PID ${process.pid})`);
    console.log(`[ccx] Configure API keys in: ${envPath}`);

    if (active) {
      console.log(`[ccx] Default provider: ${active.provider}:${active.model}`);
    }

    // Show Google login status (account 1)
    const gStatus = await getLoginStatus();
    if (gStatus.loggedIn) {
      console.log(`[ccx] Google acct1: logged in as ${gStatus.email || "unknown"} (${gStatus.mode})`);
    } else {
      console.log(`[ccx] Google acct1: not logged in. Visit http://127.0.0.1:${PORT}/google/login to authenticate`);
    }

    // Show Google account 2 status (failover account)
    const g2Status = await getLoginStatus(2);
    if (g2Status.loggedIn) {
      console.log(`[ccx] Google acct2: logged in as ${g2Status.email || "unknown"} (${g2Status.mode})`);
    } else {
      console.log(`[ccx] Google acct2: not linked. Visit http://127.0.0.1:${PORT}/google/login/2 to add failover account`);
    }

    // Show Codex/OpenAI login status
    const cStatus = await getCodexLoginStatus();
    if (cStatus.loggedIn) {
      console.log(`[ccx] OpenAI: logged in as ${cStatus.email || "unknown"} (${cStatus.plan || "unknown"}) via ${cStatus.source}`);
    } else {
      console.log(`[ccx] OpenAI: not logged in. Visit http://127.0.0.1:${PORT}/codex/login or use Codex CLI`);
    }
  })
  .catch((err) => {
    console.error("[ccx] Failed to start proxy:", err.message);
    process.exit(1);
  });
