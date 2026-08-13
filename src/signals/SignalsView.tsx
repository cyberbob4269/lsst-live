// Signals view (Round 9A) — the X-intelligence "nervous system" tab.
//
// One manual "Run sweep now" button walks the curated sweep defs
// (./sweepDefs.ts) SEQUENTIALLY through Grok's server-side X MCP tools
// (./xintel.ts) and renders one card per topic: relevance badge, summary,
// top 3 posts with link-out. A failing sweep shows its error on its own
// card — it never kills the rest. Results persist to the workspace at
// `.vera/signals.json` (loaded when the view becomes visible, so agent-run
// sweeps from the chat also show up). The free-ask box at the bottom sends a
// single question to Grok via xintelAsk.
//
// Every run spends xAI API credit — the button is a two-click confirm.

import { useCallback, useEffect, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { fsEnsureDir, fsReadFile, fsWriteFile } from "../ide/ipc";
import { SWEEP_DEFS } from "./sweepDefs";
import { xintelAsk, xintelSweep, type SweepResult } from "./xintel";

const VERA_DIR = ".vera";
const SIGNALS_PATH = ".vera/signals.json";

/** Schema of `.vera/signals.json` — last sweep run, all topic results. */
interface SignalsFile {
  lastRunAt: string | null;
  results: SweepResult[];
}

function relevanceClass(score: number | null): string {
  if (score === null) return "";
  if (score >= 7) return " is-high";
  if (score >= 4) return " is-mid";
  return " is-low";
}

export default function SignalsView({ visible }: { visible: boolean }) {
  const [results, setResults] = useState<SweepResult[]>([]);
  const [lastRunAt, setLastRunAt] = useState<string | null>(null);
  const [sweeping, setSweeping] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [question, setQuestion] = useState("");
  const [askBusy, setAskBusy] = useState(false);
  const [answer, setAnswer] = useState<{ question: string; text: string } | null>(null);
  const [askError, setAskError] = useState<string | null>(null);

  // Load persisted results when the view becomes visible (keep-alive: the
  // mount happens at boot, the first real load on first visit).
  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    (async () => {
      try {
        const file = await fsReadFile(SIGNALS_PATH);
        const parsed = JSON.parse(file.content) as Partial<SignalsFile>;
        if (cancelled) return;
        setResults(Array.isArray(parsed.results) ? parsed.results : []);
        setLastRunAt(typeof parsed.lastRunAt === "string" ? parsed.lastRunAt : null);
      } catch {
        // Missing/corrupt file — empty state.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [visible]);

  const persist = useCallback((next: SignalsFile) => {
    // Fire-and-forget like saveSettingsFile — a persistence hiccup must not
    // break the view.
    (async () => {
      try {
        await fsEnsureDir(VERA_DIR);
        await fsWriteFile(SIGNALS_PATH, JSON.stringify(next, null, 2));
      } catch (err) {
        console.error("[vera] signals save failed", err);
      }
    })();
  }, []);

  const runSweep = useCallback(async () => {
    setSweeping(true);
    setConfirming(false);
    try {
      const next = await xintelSweep(SWEEP_DEFS);
      const stamp = new Date().toISOString();
      setResults(next);
      setLastRunAt(stamp);
      persist({ lastRunAt: stamp, results: next });
    } finally {
      setSweeping(false);
    }
  }, [persist]);

  const ask = useCallback(async () => {
    const q = question.trim();
    if (!q || askBusy) return;
    setAskBusy(true);
    setAskError(null);
    try {
      const text = await xintelAsk(q);
      setAnswer({ question: q, text });
      setQuestion("");
    } catch (err) {
      setAskError(String(err));
    } finally {
      setAskBusy(false);
    }
  }, [question, askBusy]);

  return (
    <div className="sig-wrap">
      <header className="ds-toolbar">
        <span className="ds-chip is-live">X Intelligence — powered by Grok</span>
        <div className="ds-actions">
          <button
            className="settings-btn"
            disabled={sweeping || confirming}
            onClick={() => setConfirming(true)}
          >
            {sweeping ? "Sweeping…" : "Run sweep now"}
          </button>
        </div>
        <span className="ds-path muted">
          {lastRunAt ? `Last sweep: ${new Date(lastRunAt).toLocaleString()}` : "No sweep yet"}
        </span>
      </header>

      {confirming && (
        <div className="approval-card sig-confirm">
          <div className="approval-title">Run all {SWEEP_DEFS.length} sweeps?</div>
          <div className="approval-label muted">
            One Grok Responses API call per topic (run sequentially) — spends xAI API credit.
          </div>
          <div className="approval-actions">
            <button className="approval-btn approve" onClick={() => void runSweep()}>
              Confirm sweep
            </button>
            <button className="approval-btn deny" onClick={() => setConfirming(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      <div className="sig-scroll">
        {results.length === 0 ? (
          <section className="settings-card sig-card">
            <h2 className="settings-card-title">What this does</h2>
            <p className="muted soc-p">
              Each sweep asks Grok to search and analyze X (Twitter) live — via xAI's
              server-side MCP tools — across {SWEEP_DEFS.length} curated topics: the solar
              system, missions &amp; launches, Vera Rubin / LSST, telescopes, general astronomy
              buzz, and your watchlist accounts. You get a relevance score, a summary, and the
              top posts per topic. Press <strong>Run sweep now</strong> to start (spends xAI API
              credit). Results are kept in <code>.vera/signals.json</code>.
            </p>
          </section>
        ) : (
          <div className="sig-grid">
            {results.map((r) => {
              const def = SWEEP_DEFS.find((d) => d.id === r.topic);
              return (
                <section key={r.topic} className="settings-card sig-card">
                  <h2 className="settings-card-title">
                    {def?.label ?? r.topic}
                    <span className={`sig-badge${relevanceClass(r.relevanceScore)}`}>
                      {r.relevanceScore === null ? "—" : `${r.relevanceScore}/10`}
                    </span>
                  </h2>
                  {r.error ? (
                    <p className="settings-feedback is-err sig-error">{r.error}</p>
                  ) : (
                    <>
                      <p className="muted soc-p">{r.summary || "(no summary)"}</p>
                      {r.rawText && (
                        <p className="muted sig-rawnote">
                          Model reply wasn't strict JSON — raw text kept.
                        </p>
                      )}
                      {r.posts.length > 0 && (
                        <ul className="sig-posts">
                          {r.posts.slice(0, 3).map((p, i) => (
                            <li key={i} className="sig-post">
                              <div className="sig-post-head">
                                <span className="sig-author">{p.author}</span>
                                <span className="muted sig-metrics">
                                  {typeof p.likes === "number" ? `♥ ${p.likes}` : ""}
                                  {typeof p.retweets === "number" ? ` ↻ ${p.retweets}` : ""}
                                </span>
                                {p.url && (
                                  <button
                                    className="icon-btn"
                                    title={p.url}
                                    onClick={() => void openUrl(p.url!)}
                                  >
                                    ↗
                                  </button>
                                )}
                              </div>
                              <div className="sig-post-text">{p.text}</div>
                            </li>
                          ))}
                        </ul>
                      )}
                    </>
                  )}
                </section>
              );
            })}
          </div>
        )}

        {/* Free-ask */}
        <section className="settings-card sig-card sig-ask">
          <h2 className="settings-card-title">Ask Grok anything about X right now…</h2>
          <div className="settings-key-row">
            <input
              className="settings-input"
              placeholder="e.g. What are people saying about the next Starship launch?"
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void ask();
              }}
              spellCheck={false}
            />
            <button
              className="settings-btn"
              disabled={!question.trim() || askBusy}
              onClick={() => void ask()}
            >
              {askBusy ? "Asking…" : "Ask"}
            </button>
          </div>
          {askError && <span className="settings-feedback is-err">{askError}</span>}
          {answer && (
            <div className="sig-answer">
              <div className="sig-answer-q muted">{answer.question}</div>
              <div className="sig-answer-text">{answer.text}</div>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
