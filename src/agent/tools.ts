// Agent tool definitions (Phase 3). Each tool is a JSON-Schema spec (sent to
// the provider) plus an executor that maps to a workspace-scoped Tauri
// command. "read" tools auto-run unless the user disables the auto-approve
// toggle; "write" tools always go through the Approve/Deny gate in the chat.
//
// Git operations are intentionally NOT separate tools — run_shell covers
// `git status` / `git diff` / etc.
//
// Phase 4-5 note: runAgentTurn accepts an extra `tools` array, so other
// views (deep-space, social) can register domain tools into the same loop.

import { fsListDir, fsReadFile, fsWriteFile } from "../ide/ipc";
import { shellExec } from "./ipc";
import type { ToolSpec } from "./types";

export interface AgentTool {
  spec: ToolSpec;
  /** read = no side effects (auto-approvable); write = needs the gate. */
  kind: "read" | "write";
  run: (args: Record<string, unknown>) => Promise<string>;
}

function requireString(args: Record<string, unknown>, name: string): string {
  const v = args[name];
  if (typeof v !== "string" || !v.trim()) {
    throw new Error(`tool argument "${name}" must be a non-empty string`);
  }
  return v;
}

export const AGENT_TOOLS: AgentTool[] = [
  {
    kind: "read",
    spec: {
      name: "read_file",
      description:
        "Read a UTF-8 text file inside the workspace. Reads are capped at 1 MB (truncated flag tells you).",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Path relative to the workspace root, or absolute inside it.",
          },
        },
        required: ["path"],
      },
    },
    run: async (args) => {
      const path = requireString(args, "path");
      const file = await fsReadFile(path);
      return file.truncated
        ? `${file.content}\n… [file truncated at 1 MB]`
        : file.content;
    },
  },
  {
    kind: "read",
    spec: {
      name: "list_dir",
      description:
        "List the entries of a directory inside the workspace (dirs first, with file sizes).",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Directory path relative to the workspace root, or absolute inside it.",
          },
        },
        required: ["path"],
      },
    },
    run: async (args) => {
      const path = requireString(args, "path");
      const entries = await fsListDir(path);
      if (entries.length === 0) return "(empty directory)";
      return entries
        .map((e) => `${e.is_dir ? "[dir] " : `${e.size} B`.padStart(10)}  ${e.name}`)
        .join("\n");
    },
  },
  {
    kind: "write",
    spec: {
      name: "write_file",
      description:
        "Write (create or overwrite) a UTF-8 text file inside the workspace. The parent directory must exist. Always show the user what you intend to write.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Target path relative to the workspace root, or absolute inside it.",
          },
          content: { type: "string", description: "Full new file content." },
        },
        required: ["path", "content"],
      },
    },
    run: async (args) => {
      const path = requireString(args, "path");
      const content = requireString(args, "content");
      await fsWriteFile(path, content);
      return `wrote ${content.length} characters to ${path}`;
    },
  },
  {
    kind: "write",
    spec: {
      name: "run_shell",
      description:
        "Run a non-interactive shell command (PowerShell) in the workspace. 30 s default timeout, 120 s max; output capped at 64 KB per stream. Use for builds, tests, git status/diff, etc.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "The command line to execute." },
        },
        required: ["command"],
      },
    },
    run: async (args) => {
      const command = requireString(args, "command");
      const r = await shellExec(command);
      const code = r.code === null ? "killed (timeout)" : String(r.code);
      return [
        `exit code: ${code}`,
        "--- stdout ---",
        r.stdout || "(empty)",
        "--- stderr ---",
        r.stderr || "(empty)",
      ].join("\n");
    },
  },
];

/** Short human summary of a tool call, for the chat bubble. */
export function summarizeCall(name: string, argsJson: string): string {
  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(argsJson || "{}") as Record<string, unknown>;
  } catch {
    return "(invalid arguments)";
  }
  switch (name) {
    case "write_file": {
      const content = typeof args.content === "string" ? args.content : "";
      return `${String(args.path ?? "?")} (${content.length} chars)`;
    }
    case "run_shell":
      return String(args.command ?? "?");
    case "read_file":
    case "list_dir":
      return String(args.path ?? "?");
    case "generate_image":
    case "generate_video": {
      const prompt = String(args.prompt ?? "");
      return `${String(args.slug ?? "?")} — ${prompt.slice(0, 90)}`;
    }
    case "postiz_create_draft": {
      const text = String(args.text ?? "");
      const media = Array.isArray(args.mediaPaths) ? args.mediaPaths.length : 0;
      return `channel ${String(args.channelId ?? "?")} — "${text.slice(0, 80)}"${media ? ` (+${media} media)` : ""}`;
    }
    default:
      return argsJson.slice(0, 120);
  }
}
