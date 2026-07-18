// AI chat panel for the IDE right dock (Phase 3). Owns the renderable entry
// list and the provider-level history; the actual tool loop lives in
// ./agentLoop.ts and talks back through hooks.
//
// Persistence (Phase 6 polish): the panel stays mounted for the app's whole
// lifetime (keep-alive views in App.tsx), the selected provider and the
// auto-approve toggle persist to `.vera/settings.json` (./settingsStore.ts),
// and the visible conversation persists to `.vera/chat-history.json`
// (./chatHistory.ts) so it survives restarts.
//
// Phase 6 polish, second cluster:
// - Tool rows are expandable and show the tool's output (builder-feedback 4).
// - The first message of a session injects a workspace snapshot (file tree,
//   open tabs, editor selection) into the system prompt (item 5).
// - write_file approvals render a diff against the current file (item 6,
//   ./ApprovalCard.tsx).
// - running/phase are reported up to IdeView and stop() is parked in a slot
//   so the IDE status bar can show agent status + a kill switch (item 7).

import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";
import { runAgentTurn, type ChatEntry } from "./agentLoop";
import { keyGet, keyStatus } from "./ipc";
import { cleanForSpeech, speakText, stopSpeaking } from "./tts";
import { AGENT_TOOLS } from "./tools";
import { SOCIAL_TOOLS } from "../social/socialTools";
import {
  loadProviderConfigs,
  loadProviderConfigsFromDisk,
  type ProviderConfig,
  type ProviderId,
} from "./providers";
import { loadSettingsFile, saveSettingsFile } from "./settingsStore";
import { loadChatHistory, saveChatHistory } from "./chatHistory";
import { buildWorkspaceContext, type EditorSnapshot } from "./workspaceContext";
import ApprovalCard from "./ApprovalCard";
import type { ChatMessage, ToolCall } from "./types";

interface PendingApproval {
  call: ToolCall;
  resolve: (approved: boolean) => void;
}

interface ChatPanelProps {
  /** Workspace root; null while the backend is still resolving it. */
  root: string | null;
  /** False while another top-level view is active. The panel stays mounted
   *  (keep-alive), so this is only used to re-sync provider configs. */
  visible: boolean;
  onOpenSettings: () => void;
  /** Latest editor snapshot (tabs, active file, selection) for the
   *  first-message workspace context. */
  getEditorSnapshot?: () => EditorSnapshot;
  /** Reports agent activity changes so the IDE status bar can mirror them. */
  onAgentStatus?: (running: boolean, phase: string | null) => void;
  /** IdeView-owned slot: the panel parks its stop() here while mounted, so
   *  the status-bar kill switch can reach it. */
  agentStopSlot?: MutableRefObject<(() => void) | null>;
}

const STATUS_ICON: Record<string, string> = {
  pending: "…",
  running: "▸",
  done: "✓",
  denied: "✗",
  error: "✗",
};

const EMPTY_SNAPSHOT: EditorSnapshot = { tabs: [], activePath: null, selection: null };

export default function ChatPanel({
  root,
  visible,
  onOpenSettings,
  getEditorSnapshot,
  onAgentStatus,
  agentStopSlot,
}: ChatPanelProps) {
  const [configs, setConfigs] = useState<ProviderConfig[]>(loadProviderConfigs);
  const [providerId, setProviderId] = useState<ProviderId>(configs[0].id);
  const [hasKeys, setHasKeys] = useState<Record<string, boolean>>({});
  const [autoApproveReads, setAutoApproveReads] = useState(true);
  /** "Speak replies" toggle (persisted): auto-read each completed assistant
   *  reply aloud via xAI TTS. Default OFF. */
  const [speakReplies, setSpeakReplies] = useState(false);
  /** Id of the chat entry currently being read aloud, if any. */
  const [speakingId, setSpeakingId] = useState<number | null>(null);
  const [entries, setEntries] = useState<ChatEntry[]>([]);
  const [input, setInput] = useState("");
  const [running, setRunning] = useState(false);
  const [phase, setPhase] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingApproval | null>(null);
  /** Ids of tool rows whose output block is expanded. */
  const [expandedTools, setExpandedTools] = useState<ReadonlySet<number>>(new Set());

  const historyRef = useRef<ChatMessage[]>([]);
  const stopRef = useRef(false);
  const seqRef = useRef(0);
  const listRef = useRef<HTMLDivElement>(null);
  /** Live mirrors for use inside send()'s async continuation (closures there
   *  would otherwise see the render-time values). */
  const speakRepliesRef = useRef(false);
  const pendingRef = useRef<PendingApproval | null>(null);
  /** Gates settings writes: false until `.vera/settings.json` has been read,
   *  so initial defaults never clobber the file before hydration. */
  const settingsHydratedRef = useRef(false);

  useEffect(() => {
    speakRepliesRef.current = speakReplies;
  }, [speakReplies]);

  useEffect(() => {
    pendingRef.current = pending;
  }, [pending]);

  useEffect(() => {
    keyStatus()
      .then((rows) => {
        const map: Record<string, boolean> = {};
        for (const r of rows) map[r.provider] = r.has_key;
        setHasKeys(map);
      })
      .catch((err) => console.error("[vera] key_status failed", err));
  }, []);

  // Hydrate persisted settings once on mount: provider configs from
  // `.vera/settings.json` (overriding localStorage), plus this panel's own
  // selected provider and auto-approve toggle.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [diskConfigs, file] = await Promise.all([
          loadProviderConfigsFromDisk(),
          loadSettingsFile(),
        ]);
        if (cancelled) return;
        setConfigs(diskConfigs);
        const sel = file?.chat.selectedProviderId;
        if (sel && diskConfigs.some((c) => c.id === sel)) {
          setProviderId(sel as ProviderId);
        }
        if (file?.chat.autoApproveReads != null) {
          setAutoApproveReads(file.chat.autoApproveReads);
        }
        if (file?.chat.speakReplies != null) {
          setSpeakReplies(file.chat.speakReplies);
        }
      } catch (err) {
        console.error("[vera] chat settings hydrate failed", err);
      } finally {
        if (!cancelled) settingsHydratedRef.current = true;
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Re-sync provider configs whenever the IDE view becomes visible again:
  // the Settings view stays mounted too, and baseUrl/model edits there go
  // straight to localStorage (the live in-session mirror).
  useEffect(() => {
    if (!visible || !settingsHydratedRef.current) return;
    setConfigs(loadProviderConfigs());
  }, [visible]);

  // Persist this panel's settings on change (after hydration only).
  useEffect(() => {
    if (!settingsHydratedRef.current) return;
    void saveSettingsFile({ chat: { selectedProviderId: providerId } });
  }, [providerId]);

  useEffect(() => {
    if (!settingsHydratedRef.current) return;
    void saveSettingsFile({ chat: { autoApproveReads } });
  }, [autoApproveReads]);

  useEffect(() => {
    if (!settingsHydratedRef.current) return;
    void saveSettingsFile({ chat: { speakReplies } });
  }, [speakReplies]);

  // Restore the previous session's visible conversation once on mount,
  // behind a divider line (the divider is ephemeral — never re-persisted).
  useEffect(() => {
    let cancelled = false;
    loadChatHistory()
      .then((file) => {
        if (cancelled || !file) return;
        const stamp = file.savedAt
          ? ` (saved ${new Date(file.savedAt).toLocaleString()})`
          : "";
        const restored: ChatEntry[] = [
          {
            id: ++seqRef.current,
            kind: "note",
            text: `— restored from previous session${stamp} —`,
            ephemeral: true,
          },
          ...file.entries.map((p) => ({ ...p, id: ++seqRef.current })),
        ];
        // Don't clobber anything already typed in this session.
        setEntries((prev) => (prev.length ? prev : restored));
      })
      .catch((err) => console.error("[vera] chat-history restore failed", err));
    return () => {
      cancelled = true;
    };
  }, []);

  // Persist the conversation (debounced) on every change — completed turns,
  // approvals and denials all flow through `entries`.
  useEffect(() => {
    if (entries.length === 0) return;
    const timer = window.setTimeout(() => {
      void saveChatHistory(entries);
    }, 400);
    return () => window.clearTimeout(timer);
  }, [entries]);

  // Auto-scroll on any new content.
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [entries, phase, pending]);

  // Mirror agent activity up to IdeView (status bar indicator + kill switch).
  useEffect(() => {
    onAgentStatus?.(running, phase);
  }, [running, phase, onAgentStatus]);

  const toggleToolRow = useCallback((id: number) => {
    setExpandedTools((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const addEntry = useCallback((e: Omit<ChatEntry, "id">) => {
    const id = ++seqRef.current;
    setEntries((prev) => [...prev, { ...e, id }]);
    return id;
  }, []);

  const patchEntry = useCallback((id: number, patch: Partial<Omit<ChatEntry, "id">>) => {
    setEntries((prev) => prev.map((e) => (e.id === id ? { ...e, ...patch } : e)));
  }, []);

  /** Read an assistant message aloud; errors surface as a chat note. The
   *  speaking highlight clears when playback ends, is stopped, or errors. */
  const playSpeech = useCallback(
    (id: number, text: string) => {
      setSpeakingId(id);
      void speakText(cleanForSpeech(text))
        .catch((err: unknown) => {
          addEntry({
            kind: "note",
            text: `Voice: ${err instanceof Error ? err.message : String(err)}`,
            isError: true,
          });
        })
        .finally(() => setSpeakingId((cur) => (cur === id ? null : cur)));
    },
    [addEntry]
  );

  /** Speaker button on an assistant bubble: click again to stop. */
  const toggleSpeak = useCallback(
    (id: number, text: string) => {
      if (speakingId === id) {
        stopSpeaking();
        setSpeakingId(null);
        return;
      }
      playSpeech(id, text);
    },
    [speakingId, playSpeech]
  );

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || running || !root) return;
    const config = configs.find((c) => c.id === providerId) ?? configs[0];
    setInput("");

    let apiKey: string | null = null;
    try {
      apiKey = await keyGet(config.id);
    } catch (err) {
      addEntry({ kind: "note", text: `Keyring error: ${String(err)}`, isError: true });
      return;
    }
    if (!apiKey) {
      addEntry({
        kind: "note",
        text: `No API key saved for ${config.label} — open Settings (Configure…) to add one.`,
        isError: true,
      });
      return;
    }

    setRunning(true);
    stopRef.current = false;
    // A new turn interrupts any voice playback from the previous one.
    stopSpeaking();
    setSpeakingId(null);
    // Filled in by the wrapped addEntry hook below: the turn's final
    // assistant message is the last one the loop adds before it returns.
    let lastAssistantId: number | null = null;
    let lastAssistantText: string | null = null;
    // First message of the session (no prior turns in the model history):
    // build the workspace snapshot once — it rides along in this turn's
    // system prompt and stays in the history from then on.
    let workspaceContext: string | undefined;
    if (historyRef.current.length === 0) {
      try {
        workspaceContext = await buildWorkspaceContext(
          root,
          getEditorSnapshot?.() ?? EMPTY_SNAPSHOT
        );
      } catch (err) {
        console.error("[vera] workspace-context build failed", err);
      }
    }
    try {
      await runAgentTurn({
        history: historyRef.current,
        userText: text,
        config,
        apiKey,
        workspaceRoot: root,
        autoApproveReads,
        workspaceContext,
        // Built-in IDE tools + the Phase 5 social domain tools; their
        // executors error cleanly when prerequisites (keys, stack) are missing.
        tools: [...AGENT_TOOLS, ...SOCIAL_TOOLS],
        hooks: {
          addEntry: (e) => {
            const id = addEntry(e);
            if (e.kind === "assistant") {
              lastAssistantId = id;
              lastAssistantText = e.text;
            }
            return id;
          },
          patchEntry,
          requestApproval: (call) =>
            new Promise<boolean>((resolve) => setPending({ call, resolve })),
          isStopped: () => stopRef.current,
          setPhase,
        },
      });
    } finally {
      setRunning(false);
      setPhase(null);
      setPending(null);
      // Auto-speak the completed reply when the toggle is on. Never speak a
      // stopped turn, and never while an approval card is still pending.
      if (
        speakRepliesRef.current &&
        lastAssistantId != null &&
        lastAssistantText &&
        !stopRef.current &&
        !pendingRef.current
      ) {
        playSpeech(lastAssistantId, lastAssistantText);
      }
    }
  }, [input, running, root, configs, providerId, autoApproveReads, addEntry, patchEntry, getEditorSnapshot, playSpeech]);

  const stop = useCallback(() => {
    stopRef.current = true;
    // Unblock a pending approval so the loop can notice the stop flag.
    setPending((p) => {
      p?.resolve(false);
      return null;
    });
  }, []);

  const answerApproval = useCallback(
    (approved: boolean) => {
      pending?.resolve(approved);
      setPending(null);
    },
    [pending]
  );

  // Park stop() in the IdeView-owned slot while this panel is mounted, so
  // the status-bar kill switch can reach it.
  useEffect(() => {
    if (!agentStopSlot) return;
    agentStopSlot.current = stop;
    return () => {
      agentStopSlot.current = null;
    };
  }, [agentStopSlot, stop]);

  const config = configs.find((c) => c.id === providerId) ?? configs[0];

  return (
    <>
      <div className="pane-title chat-title">
        <span>AI Chat</span>
        <button className="icon-btn chat-config-link" onClick={onOpenSettings}>
          Configure…
        </button>
      </div>

      <div className="chat-controls">
        <select
          className="chat-provider"
          value={providerId}
          onChange={(e) => setProviderId(e.target.value as ProviderId)}
          disabled={running}
          title="Provider + model (edit in Settings)"
        >
          {configs.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label} — {c.model}
              {hasKeys[c.id] ? "" : " (no key)"}
            </option>
          ))}
        </select>
        <label className="chat-toggle" title="Run read_file / list_dir without asking">
          <input
            type="checkbox"
            checked={autoApproveReads}
            onChange={(e) => setAutoApproveReads(e.target.checked)}
          />
          auto-approve reads
        </label>
        <label className="chat-toggle" title="Read assistant replies aloud (xAI TTS, uses your xAI key)">
          <input
            type="checkbox"
            checked={speakReplies}
            onChange={(e) => setSpeakReplies(e.target.checked)}
          />
          speak replies
        </label>
      </div>

      <div className="chat-list" ref={listRef}>
        {entries.length === 0 && (
          <div className="chat-empty muted">
            Ask the agent to inspect or modify the workspace. Writes and shell
            commands need your approval.
          </div>
        )}
        {entries.map((e) =>
          e.kind === "tool" ? (
            <div key={e.id} className={`chat-entry chat-tool is-${e.toolStatus}`}>
              <div
                className={`tool-head${e.output ? " is-expandable" : ""}`}
                onClick={e.output ? () => toggleToolRow(e.id) : undefined}
                role={e.output ? "button" : undefined}
                title={e.output ? "Show/hide tool output" : undefined}
              >
                <span className="tool-status">{STATUS_ICON[e.toolStatus ?? "pending"]}</span>
                <span className="tool-name">{e.toolName}</span>
                <span className="tool-args">{e.text}</span>
                {e.output && (
                  <span className="tool-chevron">{expandedTools.has(e.id) ? "▾" : "▸"}</span>
                )}
              </div>
              {e.output && expandedTools.has(e.id) && (
                <pre className="tool-output">{e.output}</pre>
              )}
            </div>
          ) : (
            <div
              key={e.id}
              className={`chat-entry chat-${e.kind}${e.isError ? " is-error" : ""}`}
            >
              <div className="chat-text">{e.text}</div>
              {e.kind === "assistant" && (
                <button
                  className={`icon-btn chat-speak${speakingId === e.id ? " is-speaking" : ""}`}
                  onClick={() => toggleSpeak(e.id, e.text)}
                  title={speakingId === e.id ? "Stop" : "Read aloud"}
                >
                  {speakingId === e.id ? "■" : "▶"}
                </button>
              )}
            </div>
          )
        )}
        {phase && (
          <div className="chat-entry chat-note">
            <span className="spinner" /> {phase}
          </div>
        )}
      </div>

      {pending && <ApprovalCard call={pending.call} onAnswer={answerApproval} />}

      <div className="chat-input-row">
        <textarea
          className="chat-input"
          rows={3}
          placeholder={root ? "Message the agent… (Enter sends, Shift+Enter newline)" : "Locating workspace…"}
          value={input}
          disabled={running || !root}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
        />
        {running ? (
          <button className="chat-send is-stop" onClick={stop} title="Stop after the current step">
            Stop
          </button>
        ) : (
          <button
            className="chat-send"
            onClick={() => void send()}
            disabled={!input.trim() || !root}
          >
            Send
          </button>
        )}
      </div>
      {!hasKeys[config.id] && (
        <div className="chat-hint muted">No API key for {config.label} yet — Configure…</div>
      )}
    </>
  );
}
