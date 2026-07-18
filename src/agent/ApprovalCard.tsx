// Approval card for gated tool calls (Phase 3; diff view added in Phase 6
// polish, builder-feedback item 6). For write_file on an EXISTING file the
// card fetches the current content and renders a compact line diff (see
// ./lineDiff.ts); new files keep the full-content view, labelled as such.
// Everything else shows the old static detail (command / raw arguments).

import { useEffect, useState } from "react";
import { fsReadFile } from "../ide/ipc";
import { compactDiff, diffLines, type DiffRow } from "./lineDiff";
import type { ToolCall } from "./types";

/** Row cap for the rendered diff — huge replacements stay scrollable-small. */
const MAX_DIFF_ROWS = 300;

interface ApprovalCardProps {
  call: ToolCall;
  onAnswer: (approved: boolean) => void;
}

interface WriteTarget {
  path: string;
  content: string;
}

function parseWriteTarget(call: ToolCall): WriteTarget | null {
  try {
    const args = JSON.parse(call.argsJson || "{}") as Record<string, unknown>;
    if (typeof args.path !== "string" || typeof args.content !== "string") return null;
    return { path: args.path, content: args.content };
  } catch {
    return null;
  }
}

/** Static detail for non-write calls: the exact command for shell, raw JSON
 *  otherwise. */
function staticDetail(call: ToolCall): { label: string; body: string } {
  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(call.argsJson || "{}") as Record<string, unknown>;
  } catch {
    return { label: "arguments", body: call.argsJson };
  }
  if (call.name === "run_shell") {
    return { label: "run_shell", body: String(args.command ?? "") };
  }
  return { label: call.name, body: JSON.stringify(args, null, 2) };
}

/** Diff body for a write_file approval: loads the existing file and computes
 *  the compact diff; falls back to the full-content view for new files. */
function WriteDiff({ target }: { target: WriteTarget }) {
  const [state, setState] = useState<
    | { status: "loading" }
    | { status: "new-file" }
    | { status: "diff"; rows: DiffRow[]; identical: boolean; oldTruncated: boolean }
  >({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    fsReadFile(target.path)
      .then((file) => {
        if (cancelled) return;
        const rows = compactDiff(diffLines(file.content, target.content));
        setState({ status: "diff", rows, identical: rows.length === 0, oldTruncated: file.truncated });
      })
      .catch(() => {
        // Read failure = the file does not exist yet (or is unreadable) —
        // present the write as a new file.
        if (!cancelled) setState({ status: "new-file" });
      });
    return () => {
      cancelled = true;
    };
  }, [target.path, target.content]);

  if (state.status === "loading") {
    return <div className="approval-body muted">Loading current file for diff…</div>;
  }

  if (state.status === "new-file") {
    return (
      <>
        <div className="approval-label muted">new file → {target.path}</div>
        <pre className="approval-body">{target.content}</pre>
      </>
    );
  }

  const shown = state.rows.slice(0, MAX_DIFF_ROWS);
  return (
    <>
      <div className="approval-label muted">
        modify → {target.path}
        {state.oldTruncated ? " (existing file read truncated at 1 MB — tail diff approximate)" : ""}
      </div>
      {state.identical ? (
        <div className="approval-body muted">No changes — content is identical.</div>
      ) : (
        <div className="approval-diff">
          {shown.map((row, i) =>
            row.kind === "gap" ? (
              <div key={i} className="diff-gap">
                ⋮ {row.count} unchanged line{row.count === 1 ? "" : "s"}
              </div>
            ) : (
              <div key={i} className={`diff-line is-${row.kind}`}>
                {row.kind === "add" ? "+ " : row.kind === "del" ? "- " : "  "}
                {row.text}
              </div>
            )
          )}
          {state.rows.length > shown.length && (
            <div className="diff-gap">… diff truncated ({state.rows.length - shown.length} more rows)</div>
          )}
        </div>
      )}
    </>
  );
}

export default function ApprovalCard({ call, onAnswer }: ApprovalCardProps) {
  const writeTarget = call.name === "write_file" ? parseWriteTarget(call) : null;
  const detail = writeTarget ? null : staticDetail(call);

  return (
    <div className="approval-card">
      <div className="approval-title">Approve {call.name}?</div>
      {writeTarget ? (
        <WriteDiff target={writeTarget} />
      ) : (
        <>
          <div className="approval-label muted">{detail!.label}</div>
          <pre className="approval-body">{detail!.body}</pre>
        </>
      )}
      <div className="approval-actions">
        <button className="approval-btn approve" onClick={() => onAnswer(true)}>
          Approve
        </button>
        <button className="approval-btn deny" onClick={() => onAnswer(false)}>
          Deny
        </button>
      </div>
    </div>
  );
}
