// Provider abstraction (Phase 3). xAI, OpenAI and Kimi/Moonshot share the
// OpenAI chat-completions wire format; Anthropic uses its native messages
// API with tool_use/tool_result blocks. Both paths convert to/from the
// internal model in ./types.ts.
//
// All requests go through tauri-plugin-http's fetch, which runs in the
// Rust backend — no CORS, and the allowed origins are whitelisted in
// src-tauri/capabilities/default.json. Non-streaming for v1, 60 s timeout.
//
// Non-secret config (base URLs, models) persists in localStorage AND in
// `<workspace>/.vera/settings.json` via ./settingsStore.ts — the file wins on
// read because localStorage is per-app-identity (dev vs installed builds have
// separate stores). API keys never touch either — they come from the OS
// credential store (./ipc.ts).

import { fetch } from "@tauri-apps/plugin-http";
import { loadSettingsFile, saveSettingsFile } from "./settingsStore";
import type { AssistantReply, ChatMessage, ToolCall, ToolSpec } from "./types";

export type ProviderId = "xai" | "openai" | "anthropic" | "kimi";

export interface ProviderConfig {
  id: ProviderId;
  label: string;
  baseUrl: string;
  model: string;
}

export const PROVIDER_DEFAULTS: ProviderConfig[] = [
  { id: "xai", label: "xAI (Grok)", baseUrl: "https://api.x.ai/v1", model: "grok-4-latest" },
  { id: "openai", label: "OpenAI", baseUrl: "https://api.openai.com/v1", model: "gpt-4o" },
  {
    id: "anthropic",
    label: "Anthropic",
    baseUrl: "https://api.anthropic.com",
    model: "claude-sonnet-4-5",
  },
  {
    id: "kimi",
    label: "Kimi (Moonshot)",
    baseUrl: "https://api.moonshot.ai/v1",
    model: "kimi-k3",
  },
];

const STORAGE_KEY = "vera.providers.v1";
const REQUEST_TIMEOUT_MS = 60_000;

/** Stored overrides merged onto the defaults (model names drift — every
 *  field stays editable in Settings). Synchronous localStorage read — the
 *  live in-session mirror; use loadProviderConfigsFromDisk() at startup so
 *  the workspace settings file (shared across app identities) can override. */
export function loadProviderConfigs(): ProviderConfig[] {
  let stored: Partial<Record<ProviderId, { baseUrl?: string; model?: string }>> = {};
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) stored = JSON.parse(raw) as typeof stored;
  } catch {
    // Corrupt storage — fall back to defaults.
  }
  return PROVIDER_DEFAULTS.map((d) => ({
    ...d,
    baseUrl: stored[d.id]?.baseUrl?.trim() || d.baseUrl,
    model: stored[d.id]?.model?.trim() || d.model,
  }));
}

/** Startup variant: sync localStorage load first, then `.vera/settings.json`
 *  overrides it when present (the file is the cross-app-identity source of
 *  truth). */
export async function loadProviderConfigsFromDisk(): Promise<ProviderConfig[]> {
  const base = loadProviderConfigs();
  const file = await loadSettingsFile();
  if (!file) return base;
  return base.map((c) => ({
    ...c,
    baseUrl: file.providers[c.id]?.baseUrl?.trim() || c.baseUrl,
    model: file.providers[c.id]?.model?.trim() || c.model,
  }));
}

export function saveProviderConfigs(configs: ProviderConfig[]): void {
  const out: Record<string, { baseUrl: string; model: string }> = {};
  for (const c of configs) out[c.id] = { baseUrl: c.baseUrl, model: c.model };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(out));
  // Dual-write to the workspace settings file (fire-and-forget; failures are
  // logged inside saveSettingsFile).
  void saveSettingsFile({ providers: out });
}

/** One non-streaming completion with tools. Throws on HTTP/transport error
 *  with the response body included so it can surface in the chat. */
export async function chatCompletion(
  config: ProviderConfig,
  apiKey: string,
  messages: ChatMessage[],
  tools: ToolSpec[]
): Promise<AssistantReply> {
  return config.id === "anthropic"
    ? anthropicCompletion(config, apiKey, messages, tools)
    : openAiCompletion(config, apiKey, messages, tools);
}

async function throwHttpError(res: Response): Promise<never> {
  const body = (await res.text()).slice(0, 2000);
  throw new Error(`HTTP ${res.status} ${res.statusText}${body ? ` — ${body}` : ""}`);
}

/* ---- OpenAI-compatible path (xAI / OpenAI / Kimi) ---- */

interface OpenAiToolCall {
  id: string;
  function: { name: string; arguments: string };
}

function toOpenAiMessages(messages: ChatMessage[]): Record<string, unknown>[] {
  return messages.map((m) => {
    if (m.role === "tool") {
      return { role: "tool", tool_call_id: m.toolCallId, content: m.content };
    }
    if (m.role === "assistant" && m.toolCalls?.length) {
      return {
        role: "assistant",
        content: m.content || null,
        tool_calls: m.toolCalls.map((c) => ({
          id: c.id,
          type: "function",
          function: { name: c.name, arguments: c.argsJson },
        })),
      };
    }
    return { role: m.role, content: m.content };
  });
}

async function openAiCompletion(
  config: ProviderConfig,
  apiKey: string,
  messages: ChatMessage[],
  tools: ToolSpec[]
): Promise<AssistantReply> {
  const res = await fetch(`${config.baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: config.model,
      messages: toOpenAiMessages(messages),
      ...(tools.length
        ? {
            tools: tools.map((t) => ({
              type: "function",
              function: { name: t.name, description: t.description, parameters: t.parameters },
            })),
          }
        : {}),
      stream: false,
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) await throwHttpError(res);
  const data = (await res.json()) as {
    choices?: { message?: { content?: string | null; tool_calls?: OpenAiToolCall[] } }[];
  };
  const msg = data.choices?.[0]?.message;
  if (!msg) throw new Error("provider returned no completion choices");
  return {
    content: msg.content ?? "",
    toolCalls: (msg.tool_calls ?? []).map((c) => ({
      id: c.id,
      name: c.function.name,
      argsJson: c.function.arguments || "{}",
    })),
  };
}

/* ---- Anthropic path ---- */

function safeParseObject(json: string): Record<string, unknown> {
  try {
    const v = JSON.parse(json) as unknown;
    return v && typeof v === "object" && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** Anthropic wants system text out-of-band, and consecutive tool results
 *  merged into a single user message of tool_result blocks. */
function toAnthropicMessages(messages: ChatMessage[]): {
  system: string;
  messages: Record<string, unknown>[];
} {
  const systemParts: string[] = [];
  const out: Record<string, unknown>[] = [];
  for (const m of messages) {
    if (m.role === "system") {
      systemParts.push(m.content);
    } else if (m.role === "user") {
      out.push({ role: "user", content: m.content });
    } else if (m.role === "assistant") {
      const blocks: Record<string, unknown>[] = [];
      if (m.content) blocks.push({ type: "text", text: m.content });
      for (const c of m.toolCalls ?? []) {
        blocks.push({
          type: "tool_use",
          id: c.id,
          name: c.name,
          input: safeParseObject(c.argsJson),
        });
      }
      out.push({
        role: "assistant",
        content: blocks.length ? blocks : [{ type: "text", text: "…" }],
      });
    } else {
      // tool result
      const block = {
        type: "tool_result",
        tool_use_id: m.toolCallId,
        content: m.content,
        ...(m.isError ? { is_error: true } : {}),
      };
      const last = out[out.length - 1];
      if (last && last.role === "user" && Array.isArray(last.content)) {
        (last.content as Record<string, unknown>[]).push(block);
      } else {
        out.push({ role: "user", content: [block] });
      }
    }
  }
  return { system: systemParts.join("\n\n"), messages: out };
}

async function anthropicCompletion(
  config: ProviderConfig,
  apiKey: string,
  messages: ChatMessage[],
  tools: ToolSpec[]
): Promise<AssistantReply> {
  const { system, messages: anthroMessages } = toAnthropicMessages(messages);
  const res = await fetch(`${config.baseUrl.replace(/\/$/, "")}/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: config.model,
      max_tokens: 4096,
      ...(system ? { system } : {}),
      messages: anthroMessages,
      ...(tools.length
        ? {
            tools: tools.map((t) => ({
              name: t.name,
              description: t.description,
              input_schema: t.parameters,
            })),
          }
        : {}),
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) await throwHttpError(res);
  const data = (await res.json()) as {
    content?: (
      | { type: "text"; text: string }
      | { type: "tool_use"; id: string; name: string; input: unknown }
    )[];
  };
  const blocks = data.content ?? [];
  const content = blocks
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("");
  const toolCalls: ToolCall[] = blocks
    .filter(
      (b): b is { type: "tool_use"; id: string; name: string; input: unknown } =>
        b.type === "tool_use"
    )
    .map((b) => ({
      id: b.id,
      name: b.name,
      argsJson: JSON.stringify(b.input ?? {}),
    }));
  return { content, toolCalls };
}
