// Live probe: does the ChatGPT/Codex backend give the model server-side web access?
// Runs chatCodexOAuth in-process against the real backend (no gateway, no restart) with NO
// client tools, so any tool the model reports or calls is a server/hosted one.
//   npx tsx scripts/probe-server-web.ts [before|after] [model]
// before = the request as the gateway built it for every lane (web_search hosted tool appended)
// after  = serverWebSearch:false, the bench path.
// Prints the model's text and whether a web_search_call item came back. Never prints tokens.
import { config } from "dotenv";
import { homedir } from "os";
import { join } from "path";
config({ path: join(homedir(), ".claude-proxy", ".env") });
import type { FastifyReply } from "fastify";
import { chatCodexOAuth } from "../adapters/providers/codex-oauth.js";

const mode = process.argv[2] === "before" ? "before" : "after";
const model = process.argv[3] ?? "gpt-6-luna";
let sse = "";
const raw = {
  writableEnded: false,
  headersSent: false,
  setHeader: () => {},
  removeHeader: () => {},
  flushHeaders: () => {},
  writeHead: () => {},
  write: (c: unknown) => { sse += String(c); return true; },
  end: () => { raw.writableEnded = true; },
};
const logs: string[] = [];
const origLog = console.log;
console.log = (...a: unknown[]) => { logs.push(a.map(String).join(" ")); };

const body: any = {
  model,
  max_tokens: 600,
  system: "You are a probe. Answer briefly.",
  messages: [{
    role: "user",
    content:
      "1) List the exact names of every tool available to you right now (including any built-in or " +
      "server-side ones such as web.run / web_search), or say NONE. 2) If you have any web tool, use it " +
      "once to fetch the title of https://example.com and report it; if not, say NO WEB TOOL.",
  }],
};
await chatCodexOAuth({ raw } as unknown as FastifyReply, body, model, undefined, "low", undefined,
  undefined, mode === "after" ? { serverWebSearch: false } : undefined);
console.log = origLog;
let text = "";
for (const line of sse.split("\n")) {
  if (!line.startsWith("data: ")) continue;
  try {
    const d = JSON.parse(line.slice(6));
    if (d.delta?.type === "text_delta") text += d.delta.text;
  } catch { /* non-json */ }
}
const req = logs.find((l) => l.includes("[codex] ChatGPT |")) ?? "";
console.log(JSON.stringify({
  mode, model,
  request_tools_count: /tools=(\d+)/.exec(req)?.[1] ?? null,
  web_search_call_seen: logs.some((l) => l.includes("web_search invoked")),
  model_text: text,
}, null, 1));
process.exit(0);
