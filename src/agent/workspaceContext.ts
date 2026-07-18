// Workspace-context injection (Phase 6 polish, builder-feedback item 5).
// On the FIRST message of a chat session ChatPanel builds this snapshot and
// agentLoop appends it to the system prompt, so the model starts out knowing
// the workspace layout, which files are open, and what text is selected —
// without burning tool calls. Built once per session, never per turn.

import { fsListDir, type DirEntry } from "../ide/ipc";

/** Cap on tree lines (root level + one level of children). */
const MAX_TREE_ENTRIES = 60;
/** Cap on the selected-text excerpt. */
const MAX_SELECTION_CHARS = 2048;

/** What the IDE editor area currently shows; supplied by IdeView. */
export interface EditorSnapshot {
  tabs: Array<{ name: string; path: string }>;
  activePath: string | null;
  /** Selected text in the active editor; null/empty when nothing selected. */
  selection: string | null;
}

/** Top two levels of the workspace tree, dirs first (fs_list_dir order).
 *  Unreadable subdirectories are skipped silently. */
async function treeSection(root: string): Promise<string[]> {
  const lines: string[] = [];
  let truncated = false;
  const push = (line: string): boolean => {
    if (lines.length >= MAX_TREE_ENTRIES) {
      truncated = true;
      return false;
    }
    lines.push(line);
    return true;
  };

  let top: DirEntry[];
  try {
    top = await fsListDir(root);
  } catch {
    return ["(file tree unavailable)"];
  }
  for (const entry of top) {
    if (!push(entry.is_dir ? `${entry.name}/` : entry.name)) break;
    if (!entry.is_dir) continue;
    try {
      const children = await fsListDir(entry.path);
      for (const child of children) {
        if (!push(`  ${child.is_dir ? `${child.name}/` : child.name}`)) break;
      }
    } catch {
      // Skip directories we cannot read — the tree is best-effort.
    }
    if (truncated) break;
  }
  if (truncated) lines.push("… (truncated — more entries not shown)");
  return lines;
}

/** Compact "## Workspace context" markdown block for the system prompt. */
export async function buildWorkspaceContext(
  root: string,
  snapshot: EditorSnapshot
): Promise<string> {
  const parts: string[] = ["## Workspace context", "", "### File tree (top 2 levels)"];
  parts.push(...(await treeSection(root)));

  parts.push("", "### Open editor tabs");
  if (snapshot.tabs.length === 0) {
    parts.push("(no files open)");
  } else {
    for (const tab of snapshot.tabs) {
      parts.push(`- ${tab.path}${tab.path === snapshot.activePath ? " (active)" : ""}`);
    }
  }

  const selection = snapshot.selection?.trim() ? snapshot.selection : null;
  if (selection) {
    const active = snapshot.activePath ?? "active editor";
    const capped =
      selection.length > MAX_SELECTION_CHARS
        ? `${selection.slice(0, MAX_SELECTION_CHARS)}\n… [selection truncated]`
        : selection;
    parts.push("", `### Current selection in ${active}`, capped);
  }

  return parts.join("\n");
}
