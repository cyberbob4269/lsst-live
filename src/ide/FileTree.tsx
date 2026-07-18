import { useCallback, useEffect, useState, type ReactNode } from "react";
import { fsListDir, type DirEntry } from "./ipc";
import { iconFor } from "./fileKinds";

interface FileTreeProps {
  root: string;
  selected: string | null;
  /** Bumped by the parent to drop the cache and reload. */
  refreshToken: number;
  onOpen(path: string): void;
  onError(message: string): void;
}

/** Workspace file tree with lazy per-directory loading. */
export default function FileTree({ root, selected, refreshToken, onOpen, onError }: FileTreeProps) {
  const [entriesByDir, setEntriesByDir] = useState<Record<string, DirEntry[]>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const loadDir = useCallback(
    async (dir: string) => {
      try {
        const entries = await fsListDir(dir);
        setEntriesByDir((prev) => ({ ...prev, [dir]: entries }));
      } catch (err) {
        onError(String(err));
      }
    },
    [onError]
  );

  useEffect(() => {
    loadDir(root);
  }, [root, loadDir]);

  // Refresh: clear the cache and reload every directory currently expanded.
  useEffect(() => {
    if (refreshToken === 0) return;
    setEntriesByDir({});
    loadDir(root);
    expanded.forEach((dir) => loadDir(dir));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshToken]);

  const toggleDir = (path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
    if (!entriesByDir[path]) loadDir(path);
  };

  const renderNodes = (dir: string, depth: number): ReactNode => {
    const entries = entriesByDir[dir];
    if (!entries) {
      return (
        <div className="tree-row muted" style={{ paddingLeft: 10 + depth * 14 }}>
          …
        </div>
      );
    }
    return entries.map((entry) => {
      const isOpen = expanded.has(entry.path);
      const isSelected = selected === entry.path;
      return (
        <div key={entry.path}>
          <button
            className={`tree-row${isSelected ? " is-selected" : ""}`}
            style={{ paddingLeft: 10 + depth * 14 }}
            title={entry.path}
            onClick={() => (entry.is_dir ? toggleDir(entry.path) : onOpen(entry.path))}
          >
            <span className="tree-icon">{entry.is_dir ? (isOpen ? "📂" : "📁") : iconFor(entry.name)}</span>
            <span className="tree-name">{entry.name}</span>
          </button>
          {entry.is_dir && isOpen && renderNodes(entry.path, depth + 1)}
        </div>
      );
    });
  };

  return <div className="file-tree">{renderNodes(root, 0)}</div>;
}
