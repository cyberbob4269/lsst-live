interface StatusBarProps {
  activePath: string | null;
  line: number;
  col: number;
  termAlive: boolean;
  /** Agent activity mirrored from ChatPanel (builder-feedback item 7). */
  agentRunning?: boolean;
  agentPhase?: string | null;
  onAgentStop?: () => void;
}

/** Slim bottom status bar: active file, cursor position, terminal state,
 *  plus a live agent indicator with a kill switch while the agent runs. */
export default function StatusBar({
  activePath,
  line,
  col,
  termAlive,
  agentRunning,
  agentPhase,
  onAgentStop,
}: StatusBarProps) {
  return (
    <footer className="status-bar">
      <div className="status-left">
        <span className="status-path" title={activePath ?? undefined}>
          {activePath ?? "No file open"}
        </span>
      </div>
      <div className="status-right">
        {agentRunning && (
          <span className="status-agent" title="The AI agent is working">
            <span className="spinner" />
            <span className="status-agent-phase">{agentPhase ?? "working…"}</span>
            <button
              className="agent-stop-btn"
              onClick={onAgentStop}
              title="Stop the agent after the current step"
            >
              Stop
            </button>
          </span>
        )}
        <span>
          Ln {line}, Col {col}
        </span>
        <span className="status-term" title={termAlive ? "Shell running" : "Shell not running"}>
          <span className={`term-dot${termAlive ? " is-alive" : ""}`} />
          {termAlive ? "terminal" : "no shell"}
        </span>
      </div>
    </footer>
  );
}
