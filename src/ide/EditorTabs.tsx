/** One open file in the editor. Dirty when `content !== saved`. */
export interface OpenTab {
  path: string;
  name: string;
  content: string;
  saved: string;
}

interface EditorTabsProps {
  tabs: OpenTab[];
  activePath: string | null;
  onSelect(path: string): void;
  onClose(path: string): void;
  onSave(): void;
}

/** Tab strip above the editor: name, dirty dot, close button, save action. */
export default function EditorTabs({ tabs, activePath, onSelect, onClose, onSave }: EditorTabsProps) {
  const active = tabs.find((t) => t.path === activePath);
  const activeDirty = !!active && active.content !== active.saved;

  return (
    <div className="editor-tabs" role="tablist">
      {tabs.length === 0 && <div className="editor-tabs-empty muted">No files open</div>}
      {tabs.map((tab) => {
        const isActive = tab.path === activePath;
        const dirty = tab.content !== tab.saved;
        return (
          <div
            key={tab.path}
            role="tab"
            aria-selected={isActive}
            className={`editor-tab${isActive ? " is-active" : ""}`}
            title={tab.path}
            onClick={() => onSelect(tab.path)}
          >
            <span className="tab-name">{tab.name}</span>
            {dirty && (
              <span className="dirty-dot" title="Unsaved changes">
                ●
              </span>
            )}
            <button
              className="tab-close"
              title="Close"
              onClick={(e) => {
                e.stopPropagation();
                onClose(tab.path);
              }}
            >
              ×
            </button>
          </div>
        );
      })}
      <button className="tab-save" onClick={onSave} disabled={!activeDirty} title="Save (Ctrl+S)">
        Save
      </button>
    </div>
  );
}
