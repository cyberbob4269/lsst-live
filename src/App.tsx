import { useCallback, useEffect, useRef, useState } from "react";
import TopBar from "./layout/TopBar";
import FileTree from "./ide/FileTree";
import EditorTabs, { type OpenTab } from "./ide/EditorTabs";
import CodeEditor from "./ide/CodeEditor";
import TerminalPanel from "./ide/TerminalPanel";
import StatusBar from "./ide/StatusBar";
import Toasts, { type ToastItem } from "./ide/Toasts";
import { fsReadFile, fsWorkspaceRoot, fsWriteFile } from "./ide/ipc";
import ChatPanel from "./agent/ChatPanel";
import type { EditorSnapshot } from "./agent/workspaceContext";
import SettingsView from "./settings/SettingsView";
import DeepSpaceView from "./deepspace/DeepSpaceView";
import DashboardsView from "./dashboards/DashboardsView";
import SocialView from "./social/SocialView";
import SignalsView from "./signals/SignalsView";
import WelcomeView from "./welcome/WelcomeView";
import { loadSettingsFile } from "./agent/settingsStore";

export type ViewId =
  | "welcome"
  | "ide"
  | "deep-space"
  | "dashboards"
  | "social"
  | "signals"
  | "settings";

/** Boot-time welcome: shown on first launch until the user opts out via
 *  "Don't show on startup". Social (Postiz/Docker) and API keys are optional. */
async function shouldShowWelcome(): Promise<boolean> {
  const file = await loadSettingsFile().catch(() => null);
  return !file?.welcome.dontShowOnBoot;
}

let toastSeq = 0;

/**
 * Three-pane IDE shell: file tree | editor tabs + Monaco | AI dock,
 * with a collapsible terminal across the bottom and a slim status bar.
 * Stays mounted for the app's lifetime (keep-alive in App below); `visible`
 * is only forwarded to children that re-sync on becoming visible.
 */
function IdeView({ visible, onOpenSettings }: { visible: boolean; onOpenSettings: () => void }) {
  const [root, setRoot] = useState<string | null>(null);
  const [tabs, setTabs] = useState<OpenTab[]>([]);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [cursor, setCursor] = useState({ line: 1, col: 1 });
  const [termAlive, setTermAlive] = useState(false);
  const [termCollapsed, setTermCollapsed] = useState(false);
  const [treeRefresh, setTreeRefresh] = useState(0);
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  /** Agent activity mirrored out of ChatPanel, shown in the status bar. */
  const [agentStatus, setAgentStatus] = useState<{ running: boolean; phase: string | null }>({
    running: false,
    phase: null,
  });

  const toast = useCallback((message: string) => {
    console.error("[vera]", message);
    const id = ++toastSeq;
    setToasts((prev) => [...prev, { id, message }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 6000);
  }, []);

  useEffect(() => {
    fsWorkspaceRoot()
      .then(setRoot)
      .catch((err) => toast(String(err)));
  }, [toast]);

  // Refs so save/key handlers always see the latest tab state.
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const activePathRef = useRef(activePath);
  activePathRef.current = activePath;
  /** Selection getter parked by the mounted CodeEditor (null when no editor
   *  is open); read lazily when the chat builds its workspace context. */
  const selectionGetterRef = useRef<(() => string | null) | null>(null);
  /** Slot ChatPanel parks its stop() into — the status-bar kill switch. */
  const agentStopRef = useRef<(() => void) | null>(null);

  /** Snapshot of the editor area for the chat's first-message context. */
  const getEditorSnapshot = useCallback((): EditorSnapshot => {
    return {
      tabs: tabsRef.current.map((t) => ({ name: t.name, path: t.path })),
      activePath: activePathRef.current,
      selection: selectionGetterRef.current?.() ?? null,
    };
  }, []);

  const handleAgentStatus = useCallback((running: boolean, phase: string | null) => {
    setAgentStatus({ running, phase });
  }, []);

  const saveActive = useCallback(async () => {
    const tab = tabsRef.current.find((t) => t.path === activePathRef.current);
    if (!tab || tab.content === tab.saved) return;
    try {
      await fsWriteFile(tab.path, tab.content);
      setTabs((prev) =>
        prev.map((t) => (t.path === tab.path ? { ...t, saved: t.content } : t))
      );
    } catch (err) {
      toast(`Save failed: ${String(err)}`);
    }
  }, [toast]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        saveActive();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [saveActive]);

  const openFile = useCallback(
    async (path: string) => {
      setActivePath(path);
      if (tabsRef.current.some((t) => t.path === path)) return;
      try {
        const file = await fsReadFile(path);
        if (file.truncated) {
          toast("File exceeds 1 MB — showing a truncated read-only snapshot.");
        }
        const name = path.split("/").pop() ?? path;
        setTabs((prev) => [
          ...prev,
          { path, name, content: file.content, saved: file.content },
        ]);
      } catch (err) {
        toast(String(err));
      }
    },
    [toast]
  );

  const closeTab = useCallback((path: string) => {
    setTabs((prev) => {
      const idx = prev.findIndex((t) => t.path === path);
      const next = prev.filter((t) => t.path !== path);
      if (activePathRef.current === path) {
        const neighbor = next[Math.min(idx, next.length - 1)];
        setActivePath(neighbor ? neighbor.path : null);
      }
      return next;
    });
  }, []);

  const updateContent = useCallback((path: string, content: string) => {
    setTabs((prev) => prev.map((t) => (t.path === path ? { ...t, content } : t)));
  }, []);

  const handleCursor = useCallback((line: number, col: number) => setCursor({ line, col }), []);

  const activeTab = tabs.find((t) => t.path === activePath) ?? null;

  return (
    <div className="ide-wrap">
      <div className="ide-grid">
        <aside className="ide-pane ide-sidebar">
          <div className="pane-title sidebar-title">
            <span>Explorer</span>
            <button
              className="icon-btn"
              title="Refresh"
              onClick={() => setTreeRefresh((n) => n + 1)}
            >
              ⟳
            </button>
          </div>
          {root ? (
            <FileTree
              root={root}
              selected={activePath}
              refreshToken={treeRefresh}
              onOpen={openFile}
              onError={toast}
            />
          ) : (
            <div className="pane-body muted">Locating workspace…</div>
          )}
        </aside>

        <section className="ide-pane ide-editor">
          <EditorTabs
            tabs={tabs}
            activePath={activePath}
            onSelect={setActivePath}
            onClose={closeTab}
            onSave={saveActive}
          />
          {activeTab ? (
            <CodeEditor
              path={activeTab.path}
              content={activeTab.content}
              onChange={(value) => updateContent(activeTab.path, value)}
              onSave={saveActive}
              onCursor={handleCursor}
              onMountEditor={(getSelection) => {
                selectionGetterRef.current = getSelection;
              }}
            />
          ) : (
            <div className="pane-body muted">
              Open a file from the Explorer — Ctrl+S saves.
            </div>
          )}
        </section>

        <aside className="ide-pane ide-dock">
          <ChatPanel
            root={root}
            visible={visible}
            onOpenSettings={onOpenSettings}
            getEditorSnapshot={getEditorSnapshot}
            onAgentStatus={handleAgentStatus}
            agentStopSlot={agentStopRef}
          />
        </aside>

        <section className={`ide-pane ide-terminal${termCollapsed ? " is-collapsed" : ""}`}>
          <div className="pane-title terminal-title">
            <span>Terminal</span>
            <span
              className={`term-dot${termAlive ? " is-alive" : ""}`}
              title={termAlive ? "Shell running" : "Shell not running"}
            />
            <button
              className="icon-btn terminal-toggle"
              title={termCollapsed ? "Expand terminal" : "Collapse terminal"}
              onClick={() => setTermCollapsed((c) => !c)}
            >
              {termCollapsed ? "▴" : "▾"}
            </button>
          </div>
          {root && (
            <TerminalPanel
              cwd={root}
              collapsed={termCollapsed}
              onAliveChange={setTermAlive}
              onError={toast}
            />
          )}
        </section>
      </div>

      <StatusBar
        activePath={activePath}
        line={cursor.line}
        col={cursor.col}
        termAlive={termAlive}
        agentRunning={agentStatus.running}
        agentPhase={agentStatus.phase}
        onAgentStop={() => agentStopRef.current?.()}
      />
      <Toasts items={toasts} />
    </div>
  );
}

export default function App() {
  const [view, setView] = useState<ViewId>("ide");

  // Welcome on first launch unless the user opted out. The IDE mounts anyway
  // (keep-alive), so the late switch costs nothing.
  useEffect(() => {
    let cancelled = false;
    shouldShowWelcome()
      .then((show) => {
        if (!cancelled && show) setView("welcome");
      })
      .catch((err) => console.error("[vera] first-run gate failed", err));
    return () => {
      cancelled = true;
    };
  }, []);

  // Keep-alive: every top-level view stays mounted for the app's lifetime;
  // switching tabs only toggles display. Chat history, Monaco tab/view state,
  // the xterm PTY and the Deep Space iframe all survive view switches.
  // Views with timers receive `visible` and must not poll while hidden.
  return (
    <div className="app-shell">
      <TopBar active={view} onSelect={setView} />
      <main className="app-main">
        <div className={`view-keepalive${view === "welcome" ? "" : " is-hidden"}`}>
          <WelcomeView
            visible={view === "welcome"}
            onOpenIde={() => setView("ide")}
            onOpenSocial={() => setView("social")}
          />
        </div>
        <div className={`view-keepalive${view === "ide" ? "" : " is-hidden"}`}>
          <IdeView visible={view === "ide"} onOpenSettings={() => setView("settings")} />
        </div>
        <div className={`view-keepalive${view === "deep-space" ? "" : " is-hidden"}`}>
          <DeepSpaceView visible={view === "deep-space"} />
        </div>
        <div className={`view-keepalive${view === "dashboards" ? "" : " is-hidden"}`}>
          <DashboardsView visible={view === "dashboards"} />
        </div>
        <div className={`view-keepalive${view === "social" ? "" : " is-hidden"}`}>
          <SocialView visible={view === "social"} onOpenWelcome={() => setView("welcome")} />
        </div>
        <div className={`view-keepalive${view === "signals" ? "" : " is-hidden"}`}>
          <SignalsView visible={view === "signals"} />
        </div>
        <div className={`view-keepalive${view === "settings" ? "" : " is-hidden"}`}>
          <SettingsView />
        </div>
      </main>
    </div>
  );
}
