// Chat-history persistence (Phase 6 polish): the visible conversation is
// serialized to `<workspace>/.vera/chat-history.json` so a new session can
// restore what was on screen.
//
// SECURITY: API keys must NEVER end up here. They never enter chat messages
// in the first place — they travel straight from the OS credential store to
// the provider request headers — and this module only serializes render
// entries (kind/text/tool status), never provider config or credentials.
//
// Only terminal render state is written. Approval-pending UI is component
// state in ChatPanel and is never serialized; tool rows still "pending" or
// "running" at save time (turn interrupted) are normalized to "denied", so a
// restored session never shows a live-looking, unresolvable tool row.

import type { ChatEntry, ToolStatus } from "./agentLoop";
import { fsEnsureDir, fsReadFile, fsWriteFile } from "../ide/ipc";

const VERA_DIR = ".vera";
const HISTORY_PATH = ".vera/chat-history.json";
/** Bound the file size — only the tail of long sessions is kept. */
const MAX_ENTRIES = 200;

/** Serialized form of one chat row (the `id` is reassigned on restore). */
export interface PersistedChatEntry {
  kind: ChatEntry["kind"];
  text: string;
  toolName?: string;
  toolStatus?: ToolStatus;
  /** Tool output preview (added in the second Phase 6 cluster). Optional so
   *  history files written by older builds — which lack it — still load. */
  output?: string;
  isError?: boolean;
}

export interface ChatHistoryFile {
  version: 1;
  savedAt: string;
  entries: PersistedChatEntry[];
}

const KINDS: ReadonlyArray<ChatEntry["kind"]> = ["user", "assistant", "tool", "note"];

/** Read `.vera/chat-history.json`; null when missing or corrupt (start
 *  fresh). Malformed rows are dropped rather than failing the whole file. */
export async function loadChatHistory(): Promise<ChatHistoryFile | null> {
  try {
    const file = await fsReadFile(HISTORY_PATH);
    const parsed = JSON.parse(file.content) as Partial<ChatHistoryFile>;
    if (!Array.isArray(parsed.entries)) return null;
    const entries = parsed.entries
      .filter(
        (e): e is PersistedChatEntry =>
          !!e &&
          typeof e === "object" &&
          KINDS.includes((e as PersistedChatEntry).kind) &&
          typeof (e as PersistedChatEntry).text === "string"
      )
      .map((e) =>
        // Drop a malformed output field rather than crashing the renderer.
        typeof e.output === "string" ? e : { ...e, output: undefined }
      );
    if (entries.length === 0) return null;
    return {
      version: 1,
      savedAt: typeof parsed.savedAt === "string" ? parsed.savedAt : "",
      entries: entries.slice(-MAX_ENTRIES),
    };
  } catch {
    return null;
  }
}

/** Serialize the visible conversation, truncated to the last MAX_ENTRIES.
 *  Entries marked `ephemeral` (e.g. the "restored session" divider) are
 *  excluded. Failures are logged, never thrown. */
export async function saveChatHistory(entries: ChatEntry[]): Promise<void> {
  try {
    const persisted: PersistedChatEntry[] = entries
      .filter((e) => !e.ephemeral)
      .slice(-MAX_ENTRIES)
      .map((e) => ({
        kind: e.kind,
        text: e.text,
        ...(e.toolName ? { toolName: e.toolName } : {}),
        ...(e.toolStatus
          ? {
              // Never persist a non-terminal status: an interrupted turn
              // restores as denied/cancelled, not as a live row.
              toolStatus:
                e.toolStatus === "pending" || e.toolStatus === "running"
                  ? ("denied" as const)
                  : e.toolStatus,
            }
          : {}),
        ...(e.isError ? { isError: true as const } : {}),
        ...(e.output ? { output: e.output } : {}),
      }));
    const payload: ChatHistoryFile = {
      version: 1,
      savedAt: new Date().toISOString(),
      entries: persisted,
    };
    await fsEnsureDir(VERA_DIR);
    await fsWriteFile(HISTORY_PATH, JSON.stringify(payload, null, 2));
  } catch (err) {
    console.error("[vera] chat-history save failed", err);
  }
}
