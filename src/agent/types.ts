// Internal message model for the agent (Phase 3). Both provider adapters
// (OpenAI-compatible and Anthropic) convert to/from these shapes, and the
// agent loop only ever sees this model.

export type Role = "system" | "user" | "assistant" | "tool";

/** A tool invocation requested by the model. */
export interface ToolCall {
  id: string;
  name: string;
  /** Raw JSON argument string, exactly as the model produced it. */
  argsJson: string;
}

export interface ChatMessage {
  role: Role;
  content: string;
  /** Set on assistant messages that request tool calls. */
  toolCalls?: ToolCall[];
  /** role === "tool": id/name of the call this message answers. */
  toolCallId?: string;
  toolName?: string;
  /** Mark tool results that carry an error (feeds is_error on Anthropic). */
  isError?: boolean;
}

/** What a provider returns for one completion: text plus any tool calls. */
export interface AssistantReply {
  content: string;
  toolCalls: ToolCall[];
}

/** Provider-agnostic tool schema (JSON Schema parameters). */
export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}
