// Deep Space view (Phase 4). Embeds the vera-home deep-space dashboard —
// a same-origin web app on http://127.0.0.1:8765 — in a full-area iframe and
// manages the backend that serves it via the vera_backend_* commands.
//
// The backend takes seconds to come up (stream ingest connects first), so the
// view polls vera_backend_status every 2.5 s while visible and swaps a
// "starting" splash for the iframe once /healthz answers. Auto-start on open
// defaults ON and persists in localStorage.
//
// Keep-alive: the view stays mounted when another tab is active (App.tsx
// hides it with display:none), so every interval here is gated on the
// `visible` prop — hidden views must not poll forever. The iframe itself
// stays mounted so the dashboard doesn't reload on every switch.

import { useCallback, useEffect, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  veraBackendStart,
  veraBackendStatus,
  veraBackendStop,
  type BackendStatus,
} from "./ipc";

const DEEP_SPACE_URL = "http://127.0.0.1:8765/ui/deep-space/index.html";
const DASHBOARD_URL = "http://127.0.0.1:8765/ui/dashboard/index.html";
/** Mirrors DEFAULT_VERA_HOME in src-tauri/src/vera_backend.rs (display only). */
const BACKEND_PATH = "C:/Users/Vera-at-home/projects/vera-home";
const AUTOSTART_KEY = "vera.deepspace.autostart.v1";
const POLL_MS = 2500;

type UiState = "idle" | "starting" | "live" | "error";

function loadAutoStart(): boolean {
  try {
    return localStorage.getItem(AUTOSTART_KEY) !== "0";
  } catch {
    return true;
  }
}

export default function DeepSpaceView({ visible }: { visible: boolean }) {
  const [status, setStatus] = useState<BackendStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [autoStart, setAutoStart] = useState<boolean>(loadAutoStart);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());
  // True once we've asked for the backend this visit — lets us tell "still
  // starting" apart from "launcher died before /healthz answered".
  const wantedRef = useRef(false);

  // Initial status + auto-start. Runs when the view first becomes visible
  // ("auto-start on open", not at app launch) and when the toggle switches on.
  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    (async () => {
      try {
        const s = await veraBackendStatus();
        if (cancelled) return;
        setStatus(s);
        if (autoStart && s.mode === "stopped") {
          wantedRef.current = true;
          setStartedAt(Date.now());
          setStatus(await veraBackendStart());
        }
      } catch (err) {
        if (!cancelled) setError(String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [autoStart, visible]);

  // Poll only while visible; the interval is torn down when the view hides
  // (it stays mounted under keep-alive, so an ungated poll would run forever).
  useEffect(() => {
    if (!visible) return;
    veraBackendStatus()
      .then(setStatus)
      .catch((err) => console.error("[vera] vera_backend_status failed", err));
    const timer = setInterval(() => {
      veraBackendStatus()
        .then(setStatus)
        .catch((err) => console.error("[vera] vera_backend_status failed", err));
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [visible]);

  const died = wantedRef.current && status?.mode === "stopped" && !status.healthy;
  const uiState: UiState =
    error || died
      ? "error"
      : status?.healthy
        ? "live"
        : wantedRef.current || status?.mode === "spawned"
          ? "starting"
          : "idle";

  // 1 s ticker for the "starting" countdown note (paused while hidden).
  useEffect(() => {
    if (uiState !== "starting" || !visible) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [uiState, visible]);

  const doStart = useCallback(async () => {
    setBusy(true);
    setError(null);
    wantedRef.current = true;
    setStartedAt(Date.now());
    try {
      setStatus(await veraBackendStart());
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }, []);

  const doStop = useCallback(async () => {
    setBusy(true);
    setError(null);
    wantedRef.current = false;
    try {
      setStatus(await veraBackendStop());
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }, []);

  const doRestart = useCallback(async () => {
    setBusy(true);
    setError(null);
    wantedRef.current = true;
    setStartedAt(Date.now());
    try {
      await veraBackendStop();
      setStatus(await veraBackendStart());
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }, []);

  const toggleAutoStart = useCallback((value: boolean) => {
    setAutoStart(value);
    try {
      localStorage.setItem(AUTOSTART_KEY, value ? "1" : "0");
    } catch {
      // Storage unavailable — the toggle just won't persist.
    }
  }, []);

  const chipText =
    uiState === "live"
      ? status?.mode === "external"
        ? "Live (external)"
        : "Live (spawned)"
      : uiState === "starting"
        ? "Starting…"
        : uiState === "error"
          ? "Error"
          : "Stopped";

  const elapsed = startedAt ? Math.max(0, Math.round((now - startedAt) / 1000)) : 0;
  const logText =
    error ??
    (status && status.lastLog.length > 0
      ? status.lastLog.join("\n")
      : "Backend exited before /healthz answered — no output captured.");

  return (
    <div className="ds-wrap">
      <header className="ds-toolbar">
        <span className={`ds-chip is-${uiState}`}>{chipText}</span>
        <div className="ds-actions">
          <button
            className="settings-btn"
            disabled={busy || uiState === "live" || uiState === "starting"}
            onClick={() => void doStart()}
          >
            Start
          </button>
          {status?.mode !== "external" && (
            <button
              className="settings-btn is-danger"
              disabled={busy || status?.mode !== "spawned"}
              onClick={() => void doStop()}
            >
              Stop
            </button>
          )}
          <button
            className="settings-btn"
            disabled={busy || uiState === "idle" || uiState === "starting"}
            onClick={() => void doRestart()}
          >
            Restart
          </button>
        </div>
        <span className="ds-path muted" title={BACKEND_PATH}>
          {BACKEND_PATH}
        </span>
        <label className="chat-toggle ds-autostart">
          <input
            type="checkbox"
            checked={autoStart}
            onChange={(e) => toggleAutoStart(e.target.checked)}
          />
          Auto-start on open
        </label>
      </header>

      <div className="ds-main">
        {uiState === "live" && (
          <iframe className="ds-iframe" src={DEEP_SPACE_URL} title="Deep Space dashboard" />
        )}

        {uiState === "starting" && (
          <div className="pane-body muted">
            <div className="ds-starting">
              <span className="spinner" />
              <p>Waiting for the vera-home backend on 127.0.0.1:8765…</p>
              <p className="muted">
                {elapsed}s elapsed — first launch can take ~30 s while the stream
                ingest connects.
              </p>
            </div>
          </div>
        )}

        {uiState === "error" && (
          <div className="ds-error">
            <p className="ds-error-title">Backend failed to start.</p>
            <pre className="ds-log">{logText}</pre>
            <button className="settings-btn" disabled={busy} onClick={() => void doStart()}>
              Retry
            </button>
          </div>
        )}

        {uiState === "idle" && (
          <div className="pane-body muted">
            Backend is stopped — press Start to launch the deep-space dashboard.
          </div>
        )}
      </div>

      <footer className="ds-footer">
        <button className="ds-link" onClick={() => void openUrl(DEEP_SPACE_URL)}>
          Open in browser
        </button>
        <button className="ds-link" onClick={() => void openUrl(DASHBOARD_URL)}>
          Plain dashboard
        </button>
        <span className="ds-url muted">{DEEP_SPACE_URL}</span>
      </footer>
    </div>
  );
}
