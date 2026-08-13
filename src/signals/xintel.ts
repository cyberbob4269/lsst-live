// Grok-powered X/Twitter intelligence client (Round 9A — "nervous system").
//
// Spike findings (2026-07, docs fetched during implementation):
//
// - xAI Remote MCP tools (https://docs.x.ai/developers/tools/remote-mcp):
//   GROK connects to MCP servers SERVER-SIDE. You declare servers in the
//   request's `tools` array as:
//     { "type": "mcp", "server_url", "server_label",
//       "server_description"?, "allowed_tools"?, "authorization"?, "headers"? }
//   Supported via the xAI native SDK and the OpenAI-compatible **Responses
//   API** — NOT chat/completions. `require_approval` and `connector_id` are
//   not supported by xAI.
//
// - Responses API request shape (https://docs.x.ai/docs/api-reference and
//   https://docs.x.ai/docs/overview):
//     POST https://api.x.ai/v1/responses
//     Authorization: Bearer <xAI key>   Content-Type: application/json
//     { "model": "grok-4.5", "input": "<text>", "tools": [ ... ] }
//   `input` (string | array) and `model` are the required fields. The
//   response is { id, object: "response", status: "completed"|"in_progress"|
//   "incomplete", output: [...], error? } where `output` is an array of items;
//   the assistant's final text is in items of type "message" whose `content`
//   holds { type: "output_text", text } blocks. Server-side MCP tool calls
//   also appear as output items (mcp_call-like entries) — we only extract the
//   final message text.
//
// - LIVE FINDING 2026-07-18: the remote-MCP path (api.x.com/mcp) failed every
//   call with HTTP 400 "Failed to connect to MCP server" — xAI requires
//   separate authorization for that endpoint. Swapped to xAI's FIRST-PARTY
//   `x_search` tool (https://docs.x.ai/developers/tools/x-search): declared as
//   { "type": "x_search", ... } in the tools array, billed to the same xAI
//   key, no MCP and no X OAuth. Strictly better for this use case.
//
// - Rust proxy allowlist: api.x.ai is already allowed, and the MCP connection
//   to api.x.com is made SERVER-SIDE by xAI, never from this app — so
//   src-tauri/src/http_proxy.rs needs NO new host. (Verified: the only URL we
//   call is <xai baseUrl>/responses.)

import { proxyPost } from "../agent/httpProxy";
import { keyGet } from "../agent/ipc";
import { loadProviderConfigsFromDisk } from "../agent/providers";
import type { SweepDef } from "./sweepDefs";

/** xAI's first-party X Search tool. Optional `allowed_x_handles` (max 20)
 *  restricts results server-side — used by the watchlist sweep. Other params
 *  per the docs if ever needed: excluded_x_handles, from_date/to_date
 *  (ISO8601), enable_image_understanding, enable_video_understanding. */
function xSearchTool(handles?: string[]): Record<string, unknown> {
  const tool: Record<string, unknown> = { type: "x_search" };
  if (handles && handles.length > 0) {
    tool.allowed_x_handles = handles.slice(0, 20);
  }
  return tool;
}

/** Sweeps can involve several server-side MCP round-trips — allow the Rust
 *  proxy's maximum (it caps at 120 s). */
const REQUEST_TIMEOUT_MS = 120_000;

export interface SweepPost {
  author: string;
  text: string;
  url?: string;
  likes?: number;
  retweets?: number;
}

export interface SweepResult {
  topic: string;
  summary: string;
  /** 0-10, null when Grok didn't produce a parseable score. */
  relevanceScore: number | null;
  posts: SweepPost[];
  /** Raw model text, kept when the strict-JSON parse failed. */
  rawText?: string;
  /** Set when the call itself failed (other sweeps still run). */
  error?: string;
}

/* ---- Responses API plumbing ---- */

interface ResponsesApiContent {
  type?: string;
  text?: string;
}

interface ResponsesApiItem {
  type?: string;
  content?: ResponsesApiContent[];
}

interface ResponsesApiBody {
  status?: string;
  error?: { message?: string } | null;
  output?: ResponsesApiItem[];
}

function extractText(data: ResponsesApiBody): string {
  const parts: string[] = [];
  for (const item of data.output ?? []) {
    if (item.type !== "message" || !Array.isArray(item.content)) continue;
    for (const c of item.content) {
      if ((c.type === "output_text" || c.type === "text") && typeof c.text === "string") {
        parts.push(c.text);
      }
    }
  }
  return parts.join("\n").trim();
}

async function requireXaiKey(): Promise<string> {
  let key: string | null = null;
  try {
    key = await keyGet("xai");
  } catch (err) {
    throw new Error(`Keyring error: ${String(err)}`);
  }
  if (!key) throw new Error("No xAI API key found — add your xAI key in Settings.");
  return key;
}

/** One non-streaming Responses API call with the x_search tool attached.
 *  Returns the model's final text. Throws with HTTP status + first 400
 *  chars of the body on provider errors. */
async function responsesCall(input: string, handles?: string[]): Promise<string> {
  const apiKey = await requireXaiKey();
  const configs = await loadProviderConfigsFromDisk();
  const xai = configs.find((c) => c.id === "xai") ?? configs[0];
  const url = `${xai.baseUrl.replace(/\/$/, "")}/responses`;
  const res = await proxyPost(
    url,
    {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    JSON.stringify({
      model: xai.model,
      input,
      tools: [xSearchTool(handles)],
    }),
    REQUEST_TIMEOUT_MS
  );
  if (res.status < 200 || res.status >= 300) {
    const body = new TextDecoder().decode(res.bytes).slice(0, 400);
    throw new Error(`HTTP ${res.status}${body ? ` — ${body}` : ""}`);
  }
  const data = JSON.parse(new TextDecoder().decode(res.bytes)) as ResponsesApiBody;
  if (data.error) {
    throw new Error(data.error.message ?? "xAI Responses API returned an error object");
  }
  const text = extractText(data);
  if (!text) {
    throw new Error(`Grok returned no text output (status: ${data.status ?? "unknown"})`);
  }
  return text;
}

/* ---- Public API ---- */

/** Ask Grok anything about X right now — a single Responses call whose
 *  server-side X MCP tools do the searching. Returns the final answer text. */
export async function xintelAsk(question: string): Promise<string> {
  const q = question.trim();
  if (!q) throw new Error("question must be non-empty");
  return responsesCall(
    "You are an X (Twitter) intelligence analyst with live access to X via the " +
      "x_search tool. Use it to research the question, then answer " +
      "concisely, citing @handles and post URLs where relevant.\n\nQuestion: " +
      q
  );
}

const SWEEP_JSON_SHAPE =
  '{ "topic": "<topic id>", "summary": "2-4 sentences", ' +
  '"relevanceScore": <integer 0-10 — how active/relevant this topic is on X right now>, ' +
  '"posts": [ { "author": "@handle", "text": "post text", "url": "https://x.com/…", ' +
  '"likes": 0, "retweets": 0 } ] }';

/** Run one sweep def: search X via Grok and demand STRICT JSON back. */
async function runSweep(def: SweepDef): Promise<SweepResult> {
  const prompt =
    `You are scanning X (Twitter) via the x_search tool for the topic "${def.id}" (${def.label}).\n` +
    `Search terms / hints: ${def.queryTerms}\n` +
    "Use x_search to find recent, high-signal posts. Then reply with STRICT JSON ONLY — " +
    "no markdown fences, no commentary — exactly this shape:\n" +
    SWEEP_JSON_SHAPE +
    "\nInclude at most 5 posts, best first. If the X tools return nothing, still reply with the " +
    "JSON object: empty posts array and the situation explained in summary.";
  const text = await responsesCall(prompt, def.handles);
  // Force the canonical topic id (the model's echo of "topic" is advisory) so
  // cards and persistence can match results to defs deterministically.
  return { ...parseSweepResult(def, text), topic: def.id };
}

function toPost(v: unknown): SweepPost | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const author = typeof o.author === "string" ? o.author : "";
  const text = typeof o.text === "string" ? o.text : "";
  if (!author && !text) return null;
  const num = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : undefined);
  return {
    author: author || "?",
    text,
    url: typeof o.url === "string" ? o.url : undefined,
    likes: num(o.likes),
    retweets: num(o.retweets),
  };
}

/** Defensive parse of the strict-JSON sweep reply: full JSON.parse first,
 *  then a first-{…last-} extraction; on failure the raw text is kept. */
export function parseSweepResult(def: SweepDef, text: string): SweepResult {
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        parsed = JSON.parse(text.slice(start, end + 1));
      } catch {
        parsed = null;
      }
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { topic: def.id, summary: text, relevanceScore: null, posts: [], rawText: text };
  }
  const o = parsed as Record<string, unknown>;
  const score =
    typeof o.relevanceScore === "number" && Number.isFinite(o.relevanceScore)
      ? Math.max(0, Math.min(10, Math.round(o.relevanceScore)))
      : null;
  const posts = Array.isArray(o.posts)
    ? o.posts.map(toPost).filter((p): p is SweepPost => p !== null)
    : [];
  return {
    topic: typeof o.topic === "string" && o.topic.trim() ? o.topic : def.id,
    summary: typeof o.summary === "string" ? o.summary : text,
    relevanceScore: score,
    posts,
  };
}

/** Run every sweep def SEQUENTIALLY (rate-safety: no parallel fan-out).
 *  A failing sweep becomes a result with `error` set — it never kills the
 *  rest of the sweep. */
export async function xintelSweep(defs: SweepDef[]): Promise<SweepResult[]> {
  const results: SweepResult[] = [];
  for (const def of defs) {
    try {
      results.push(await runSweep(def));
    } catch (err) {
      results.push({
        topic: def.id,
        summary: "",
        relevanceScore: null,
        posts: [],
        error: String(err),
      });
    }
  }
  return results;
}
