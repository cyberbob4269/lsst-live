// The agent tool loop (Phase 3). One `runAgentTurn` call = one user message
// plus up to MAX_ITERATIONS completion→tool round-trips. The loop owns no
// React state — it talks to the chat UI through LoopHooks, so approvals are
// a Promise the panel resolves when the user clicks Approve/Deny.

import { chatCompletion, type ProviderConfig } from "./providers";
import { AGENT_TOOLS, summarizeCall, type AgentTool } from "./tools";
import type { ChatMessage, ToolCall } from "./types";

export type ToolStatus = "pending" | "running" | "done" | "denied" | "error";

/** One renderable line in the chat panel. */
export interface ChatEntry {
  id: number;
  kind: "user" | "assistant" | "tool" | "note";
  text: string;
  toolName?: string;
  toolStatus?: ToolStatus;
  /** Tool output (or error) preview, set when the tool finishes — expandable
   *  in the chat row and persisted to `.vera/chat-history.json`. */
  output?: string;
  isError?: boolean;
  /** Session-only row (e.g. the "restored session" divider) — never written
   *  to `.vera/chat-history.json` (see ./chatHistory.ts). */
  ephemeral?: boolean;
}

export interface LoopHooks {
  addEntry: (entry: Omit<ChatEntry, "id">) => number;
  patchEntry: (id: number, patch: Partial<Omit<ChatEntry, "id">>) => void;
  /** Resolves true on Approve, false on Deny. */
  requestApproval: (call: ToolCall) => Promise<boolean>;
  /** Checked between iterations and before each tool — the Stop button. */
  isStopped: () => boolean;
  /** Spinner text for the header; null clears it. */
  setPhase: (phase: string | null) => void;
}

export interface RunTurnOptions {
  /** Provider-level history from previous turns (system prompt excluded —
   *  it is rebuilt each turn). Mutated in place. */
  history: ChatMessage[];
  userText: string;
  config: ProviderConfig;
  apiKey: string;
  workspaceRoot: string;
  autoApproveReads: boolean;
  /** Optional workspace snapshot appended to the system prompt — ChatPanel
   *  builds it for the first message of a session only (./workspaceContext.ts). */
  workspaceContext?: string;
  /** Extra/override tools; defaults to the built-in AGENT_TOOLS. */
  tools?: AgentTool[];
  hooks: LoopHooks;
}

const MAX_ITERATIONS = 8;

/** Cap on tool output fed back into the model context. */
const MAX_RESULT_CHARS = 20_000;

/** Cap on the tool output preview shown in (and persisted with) the chat
 *  row — the full result stays in the model history regardless. */
const MAX_OUTPUT_PREVIEW_CHARS = 4_096;

function systemPrompt(root: string, workspaceContext?: string): string {
  const lines = [
    "You are the Vera Terminal agent — an AI pair-programmer embedded in a small IDE.",
    `The workspace root is: ${root}`,
    "All file and shell tools are confined to this workspace; prefer paths relative to the root.",
    "Be concise. Before using a tool, say in one short sentence what you are about to do and why.",
    "Never run destructive commands (deleting files, force-pushing, killing processes) unless the user explicitly asked for that exact action.",
    "Social tools: generate_image / generate_video spend xAI API credit — confirm the exact prompt and slug with the user before calling them. postiz_create_draft creates a DRAFT only: never attempt to publish, schedule, or otherwise live-post; drafts are reviewed by a human in the Postiz UI.",
    "X-intel tools: xintel_ask / xintel_sweep spend xAI API credit (Grok searches X via server-side MCP tools) — confirm with the user before calling them.",
  ];
  // Snapshot of the user's workspace (file tree, open tabs, selection) —
  // injected only on the first message of a session, never rebuilt per turn.
  if (workspaceContext) lines.push("", workspaceContext);
  return lines.join("\n");
}

function clipForContext(text: string): string {
  return text.length > MAX_RESULT_CHARS
    ? `${text.slice(0, MAX_RESULT_CHARS)}\n… [result truncated for context]`
    : text;
}

/** Preview of a tool result for the chat row, capped with a truncation note. */
function previewOutput(text: string): string {
  return text.length > MAX_OUTPUT_PREVIEW_CHARS
    ? `${text.slice(0, MAX_OUTPUT_PREVIEW_CHARS)}\n… [output truncated — ${text.length} chars total]`
    : text;
}

export async function runAgentTurn(opts: RunTurnOptions): Promise<void> {
  const { hooks } = opts;
  const tools = opts.tools ?? AGENT_TOOLS;
  const history = opts.history;
  history.push({ role: "system", content: systemPrompt(opts.workspaceRoot, opts.workspaceContext) });
  history.push({ role: "user", content: opts.userText });
  hooks.addEntry({ kind: "user", text: opts.userText });

  let stopped = false;
  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    if (hooks.isStopped()) {
      stopped = true;
      break;
    }

    hooks.setPhase("thinking…");
    let reply;
    try {
      reply = await chatCompletion(
        opts.config,
        opts.apiKey,
        history,
        tools.map((t) => t.spec)
      );
    } catch (err) {
      hooks.addEntry({ kind: "note", text: `Provider error: ${String(err)}`, isError: true });
      return;
    } finally {
      hooks.setPhase(null);
    }

    history.push({
      role: "assistant",
      content: reply.content,
      toolCalls: reply.toolCalls.length ? reply.toolCalls : undefined,
    });
    if (reply.content) {
      hooks.addEntry({ kind: "assistant", text: reply.content });
    }

    // No tool calls → final answer, turn over.
    if (reply.toolCalls.length === 0) return;

    for (const call of reply.toolCalls) {
      if (hooks.isStopped()) {
        stopped = true;
        // Keep history consistent: every tool_call needs a tool result,
        // even when the turn is abandoned.
        history.push({
          role: "tool",
          toolCallId: call.id,
          toolName: call.name,
          content: "Turn stopped by the user before this tool ran.",
        });
        continue;
      }
      const tool = tools.find((t) => t.spec.name === call.name);
      const entryId = hooks.addEntry({
        kind: "tool",
        toolName: call.name,
        text: summarizeCall(call.name, call.argsJson),
        toolStatus: "pending",
      });

      let resultText: string;
      let isError = false;
      if (!tool) {
        resultText = `unknown tool: ${call.name}`;
        isError = true;
        hooks.patchEntry(entryId, { toolStatus: "error", output: previewOutput(resultText) });
      } else {
        const needsApproval = tool.kind === "write" || !opts.autoApproveReads;
        if (needsApproval) hooks.setPhase(`waiting approval: ${call.name}`);
        const approved = needsApproval ? await hooks.requestApproval(call) : true;
        if (needsApproval) hooks.setPhase(null);
        if (!approved) {
          resultText =
            "The user denied this action. Do not retry the same action; continue with the information you have or ask the user how to proceed.";
          hooks.patchEntry(entryId, { toolStatus: "denied" });
        } else {
          hooks.patchEntry(entryId, { toolStatus: "running" });
          hooks.setPhase(`${call.name}…`);
          try {
            const args = JSON.parse(call.argsJson || "{}") as Record<string, unknown>;
            resultText = await tool.run(args);
            hooks.patchEntry(entryId, { toolStatus: "done", output: previewOutput(resultText) });
          } catch (err) {
            resultText = String(err);
            isError = true;
            hooks.patchEntry(entryId, { toolStatus: "error", output: previewOutput(resultText) });
          } finally {
            hooks.setPhase(null);
          }
        }
      }

      history.push({
        role: "tool",
        toolCallId: call.id,
        toolName: call.name,
        content: clipForContext(resultText),
        isError: isError || undefined,
      });
    }
  }

  hooks.addEntry({
    kind: "note",
    text: stopped
      ? "Stopped by user."
      : `Stopped after ${MAX_ITERATIONS} tool iterations — ask the agent to continue if needed.`,
  });
}
