import type { AnthropicRequest } from "./types.js";

export const searchNote = "\n\nIMPORTANT: You have native server-side web search. Do NOT use the WebSearch or WebFetch tools — they will not work. Instead, use your built-in web search capability when you need to look something up online. There is no server-side equivalent of WebFetch — you cannot retrieve one specific URL this way. If the task requires the contents of a specific URL, say so plainly in your answer instead of substituting a general web search for it.";

// Whether the strip notice has been logged for a provider. The inability to fetch URLs is
// static per lane (Claude Code resends its full tool list every turn), so the notice is
// logged once per provider per process instead of once per turn.
const loggedProviders = new Set<string>();

/** Test-only: forget which providers have already logged the strip notice. */
export function __resetSubstitutionLogState() {
  loggedProviders.clear();
}

export function applyNativeSearchSubstitution(body: AnthropicRequest, provider: string) {
  const removed = (body.tools ?? [])
    .filter((t) => t.name === "WebSearch" || t.name === "WebFetch")
    .map((t) => t.name);
  if (body.tools) {
    body.tools = body.tools.filter((t) => t.name !== "WebSearch" && t.name !== "WebFetch");
  }
  if (removed.length > 0 && !loggedProviders.has(provider)) {
    loggedProviders.add(provider);
    console.log(`[ccx] web tools stripped for ${provider}: ${removed.join(",")} - native search substituted; logged once per lane per process${removed.includes("WebFetch") ? "; WebFetch has NO equivalent" : ""}`);
  }

  if (Array.isArray(body.system)) {
    body.system = [...body.system, { type: "text", text: searchNote }];
  } else if (body.system) {
    body.system = body.system + searchNote;
  } else {
    body.system = searchNote.trim();
  }
}
