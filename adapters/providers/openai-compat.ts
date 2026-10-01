// Shared OpenAI-compatible chat-completions streamer (Anthropic <-> OpenAI).
// Used by openrouter and cline-pass adapters.
import { FastifyReply } from "fastify";
import { createParser } from "eventsource-parser";
import type { EventSourceMessage } from "eventsource-parser";
import { sendEvent } from "../sse.js";
import { markLaneDown, markLaneOk } from "../provider-health.js";
import type { AnthropicRequest, AnthropicMessage, AnthropicTool, AnthropicContentBlock, ProviderKey } from "../types.js";

// ── Lane health ───────────────────────────────────────────────────────
//
// Shared by every caller of streamOpenAICompatible (openrouter, deepseek, cline-pass), whose
// `label` is deliberately already spelled the same as its ProviderKey - see the cast at the
// call site below. See provider-health.ts for what "definitive" means here.
//
// 402 is the one signal every pay-per-token OpenAI-compatible API (DeepSeek, OpenRouter)
// spells the same way for "no credit left on this key", so the status code alone is enough -
// unlike codex's usage-limit response, nothing else on these APIs returns 402.
//
// 401/403 are classified as "auth-expired" too, but only when the caller says the attempt
// cannot be retried (see `authMayRetry` below): cline-pass's own 401 handling refreshes and
// retries once before its final failure surfaces, and treating that first, recoverable 401 as
// definitive would flip the lane down and back up within one request. DeepSeek and OpenRouter
// have no refresh step, so their 401/403 is always the terminal answer.
function classifyOpenAICompatError(status: number, text: string): string | null {
  if (status === 402) return "balance-402";
  if (status === 429 && /insufficient.?(balance|credit)|out of credit/i.test(text)) return "balance-402";
  if (status === 401 || status === 403) return "auth-expired";
  return null;
}

export function toOpenAITools(tools: AnthropicTool[]) {
  return tools.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description ?? "",
      parameters: t.input_schema ?? { type: "object", properties: {} },
    },
  }));
}

// `echoReasoning` re-attaches the assistant's own thinking as OpenAI-style
// `reasoning_content`. DeepSeek V4 requires it: once thinking is on, a turn that
// replays an earlier assistant message without its reasoning is rejected with
// 400 "The `reasoning_content` in the thinking mode must be passed back to the
// API." That lands on the SECOND request of any tool-using conversation - the
// first call has no prior assistant turn to replay - so a deepseek agent got
// exactly one tool call and then failed on every subsequent one. Verified
// against api.deepseek.com: the identical round-trip returns 400 without the
// echo and 200 with it, at every reasoning_effort level including none.
//
// Off by default. The field is DeepSeek's own spelling, and openrouter and
// cline-pass never agreed to receive it - a provider that ignores unknown keys
// is luck, not a contract.
export function toOpenAIMessagesWithTools(messages: AnthropicMessage[], echoReasoning = false) {
  const out: any[] = [];

  for (const m of messages) {
    if (typeof m.content === "string") {
      out.push({ role: m.role, content: m.content });
      continue;
    }

    const textParts: string[] = [];
    const reasoningParts: string[] = [];
    const toolCalls: any[] = [];
    const toolResults: any[] = [];

    for (const block of m.content as AnthropicContentBlock[]) {
      if (block.type === "text") {
        textParts.push(block.text);
      } else if (block.type === "thinking") {
        // redacted_thinking carries opaque `data` rather than text, so there is
        // nothing to replay - it is skipped rather than sent as a wrong shape.
        reasoningParts.push(block.thinking);
      } else if (block.type === "tool_use") {
        toolCalls.push({
          id: block.id,
          type: "function",
          function: {
            name: block.name,
            arguments: typeof block.input === "string" ? block.input : JSON.stringify(block.input),
          },
        });
      } else if (block.type === "tool_result") {
        const content = typeof block.content === "string" ? block.content : JSON.stringify(block.content);
        toolResults.push({ role: "tool", tool_call_id: block.tool_use_id, content });
      }
    }

    const reasoning =
      echoReasoning && m.role === "assistant" && reasoningParts.length > 0
        ? { reasoning_content: reasoningParts.join("") }
        : {};

    if (m.role === "assistant" && toolCalls.length > 0) {
      out.push({ role: "assistant", content: textParts.join("") || null, tool_calls: toolCalls, ...reasoning });
    } else if (textParts.length > 0) {
      out.push({ role: m.role, content: textParts.join(""), ...reasoning });
    }

    for (const tr of toolResults) out.push(tr);
  }

  return out;
}

export type OpenAICompatOptions = {
  url: string;
  headers: Record<string, string>;
  model: string;
  label: string;
  reasoningEffort?: string;
  extraBody?: Record<string, unknown>;
  /** Replay assistant thinking as `reasoning_content`. Required by DeepSeek. */
  echoReasoning?: boolean;
  /**
   * Set by a caller that is about to retry a 401/403 itself (cline-pass's forced-refresh
   * attempt). Suppresses auth-expired classification for THIS call so the lane isn't marked
   * down for a failure the caller is already about to resolve; omit (or leave undefined) on
   * every call that has no further retry, so a genuinely terminal 401/403 is written.
   */
  authMayRetry?: boolean;
};

export async function streamOpenAICompatible(
  res: FastifyReply,
  body: AnthropicRequest,
  opts: OpenAICompatOptions,
) {
  const { url, headers, model, label, reasoningEffort, extraBody, echoReasoning, authMayRetry } = opts;

  const hasTools = !!(body.tools && body.tools.length > 0);
  const messages = toOpenAIMessagesWithTools(body.messages, echoReasoning);

  if (body.system) {
    const sysText = Array.isArray(body.system)
      ? (body.system as any[]).map((b: any) => b.text ?? "").join("\n")
      : body.system;
    messages.unshift({ role: "system", content: sysText });
  }

  const reqBody: any = {
    model,
    messages,
    stream: true,
    temperature: body.temperature ?? 0.7,
    max_tokens: body.max_tokens,
    ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
    ...(extraBody ?? {}),
  };

  if (hasTools) {
    reqBody.tools = toOpenAITools(body.tools!);
    console.log(`[${label}] Sending ${body.tools!.length} tools (OpenAI format)`);
  }

  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(reqBody),
  });

  if (!resp.ok || !resp.body) {
    const text = await safeText(resp);
    const isRetriableAuth = authMayRetry && (resp.status === 401 || resp.status === 403);
    const reason = isRetriableAuth ? null : classifyOpenAICompatError(resp.status, text);
    if (reason) markLaneDown(label as ProviderKey, reason, text);
    throw withStatus(resp.status || 500, `${label} error: ${text}`);
  }
  markLaneOk(label as ProviderKey);

  const msgId = `msg_${Date.now()}`;
  let contentIndex = 0;
  let hasStartedMessage = false;
  let hasStartedThinking = false;
  let hasStartedContent = false;

  const pendingToolCalls: Record<number, { id: string; name: string; arguments: string }> = {};

  function ensureMessageStarted() {
    if (!hasStartedMessage) {
      hasStartedMessage = true;
      sendEvent(res, "message_start", {
        type: "message_start",
        message: {
          id: msgId,
          type: "message",
          role: "assistant",
          model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      });
    }
  }

  function ensureThinkingBlockStarted() {
    if (!hasStartedThinking) {
      hasStartedThinking = true;
      ensureMessageStarted();
      sendEvent(res, "content_block_start", {
        type: "content_block_start",
        index: contentIndex,
        content_block: { type: "thinking", thinking: "" },
      });
    }
  }

  function closeThinkingBlock() {
    if (hasStartedThinking) {
      sendEvent(res, "content_block_stop", { type: "content_block_stop", index: contentIndex });
      contentIndex++;
      hasStartedThinking = false;
    }
  }

  function ensureContentBlockStarted() {
    if (!hasStartedContent) {
      closeThinkingBlock();
      hasStartedContent = true;
      ensureMessageStarted();
      sendEvent(res, "content_block_start", {
        type: "content_block_start",
        index: contentIndex,
        content_block: { type: "text", text: "" },
      });
    }
  }

  function closeContentBlock() {
    if (hasStartedContent) {
      sendEvent(res, "content_block_stop", { type: "content_block_stop", index: contentIndex });
      contentIndex++;
      hasStartedContent = false;
    }
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  const parser = createParser({
    onEvent(event: EventSourceMessage) {
      const data = event.data;
      if (!data || data === "[DONE]") return;
      try {
        const json = JSON.parse(data);
        const choice = json.choices?.[0];
        if (!choice) return;
        const delta = choice.delta;
        if (!delta) return;

        const reasoningChunk = delta.reasoning ?? delta.reasoning_content ?? "";
        if (reasoningChunk) {
          ensureThinkingBlockStarted();
          sendEvent(res, "content_block_delta", {
            type: "content_block_delta",
            index: contentIndex,
            delta: { type: "thinking_delta", thinking: reasoningChunk },
          });
        }

        const textChunk = delta.content || "";
        if (textChunk) {
          ensureContentBlockStarted();
          sendEvent(res, "content_block_delta", {
            type: "content_block_delta",
            index: contentIndex,
            delta: { type: "text_delta", text: textChunk },
          });
        }

        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index ?? 0;
            if (!pendingToolCalls[idx]) pendingToolCalls[idx] = { id: "", name: "", arguments: "" };
            if (tc.id) pendingToolCalls[idx].id = tc.id;
            if (tc.function?.name) pendingToolCalls[idx].name += tc.function.name;
            if (tc.function?.arguments) pendingToolCalls[idx].arguments += tc.function.arguments;
          }
        }
      } catch {
        // ignore parse errors
      }
    },
  });

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    parser.feed(decoder.decode(value));
  }

  ensureMessageStarted();
  closeThinkingBlock();
  closeContentBlock();

  const toolCallEntries = Object.values(pendingToolCalls);
  for (const tc of toolCallEntries) {
    sendEvent(res, "content_block_start", {
      type: "content_block_start",
      index: contentIndex,
      content_block: { type: "tool_use", id: tc.id, name: tc.name, input: {} },
    });
    sendEvent(res, "content_block_delta", {
      type: "content_block_delta",
      index: contentIndex,
      delta: { type: "input_json_delta", partial_json: tc.arguments },
    });
    sendEvent(res, "content_block_stop", { type: "content_block_stop", index: contentIndex });
    contentIndex++;
  }

  const stopReason = toolCallEntries.length > 0 ? "tool_use" : "end_turn";

  sendEvent(res, "message_delta", {
    type: "message_delta",
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: { output_tokens: 0 },
  });
  sendEvent(res, "message_stop", { type: "message_stop" });

  res.raw.end();
}

export function withStatus(status: number, message: string) {
  const e = new Error(message);
  // @ts-ignore
  e.statusCode = status;
  return e;
}

async function safeText(resp: Response) {
  try {
    return await resp.text();
  } catch {
    return "<no-body>";
  }
}
