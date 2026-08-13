// BackendFrame — reusable shell for embedding a vera-home web page served by
// the shared vera-home backend on http://127.0.0.1:8765. Extracted from
// DeepSpaceView (Round 9B) so every backend-served view (Deep Space, TOI Lab,
// Dashboard, Screensaver) gets the same lifecycle UI without triplicating it:
//
//   - control bar: status chip, Start/Stop/Restart, auto-start toggle
//   - iframe once /healthz answers, "starting" splash with countdown before
//   - error card with the backend's last captured log lines
//   - footer with an "open in browser" link (label overridable) + URL
//
// The backend lifecycle lives in ONE shared Rust manager (VeraBackendManager,
// see src-tauri/src/vera_backend.rs): start is adopt-don't-duplicate, so
// starting it from any view makes every BackendFrame go live, and external
// instances are adopted, never killed.
//
// Keep-alive contract (same as DeepSpaceView): the view stays mounted when
// hidden; `visible` gates every interval so hidden views never poll.

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  veraBackendStart,
  veraBackendStatus,
  veraBackendStop,
  type BackendStatus,
} from "./ipc";

const BACKEND_ORIGIN = "http://127.0.0.1:8765";
/** Mirrors DEFAULT_VERA_HOME in src-tauri/src/vera_backend.rs (display only). */
const BACKEND_PATH = "C:/Users/Vera-at-home/projects/vera-home";
/**
 * Auto-start preference is SHARED across all BackendFrame views: the backend
 * itself is shared (one manager, one port), so one toggle covers them all.
 * Key name kept from DeepSpaceView so the existing preference carries over.
 */
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

export interface BackendFrameProps {
  /** Human name — used for the iframe title and idle/error copy. */
  title: string;
  /** URL path under the backend origin, e.g. "/ui/deep-space/index.html". */
  path: string;
  /** False while the view is hidden (keep-alive) — gates all polling. */
  visible: boolean;
  /** Label for the footer link that opens the page in the system browser. */
  openLinkLabel?: string;
  /** Extra footer links, rendered after the open-in-browser link. */
  footerExtra?: ReactNode;
}

export default function BackendFrame({
  title,
  path,
  visible,
  openLinkLabel = "Open in browser",
  footerExtra,
}: BackendFrameProps) {
  const url = `${BACKEND_ORIGIN}${path}`;
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
        {uiState === "live" && <iframe className="ds-iframe" src={url} title={title} />}

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
            Backend is stopped — press Start to launch {title}.
          </div>
        )}
      </div>

      <footer className="ds-footer">
        <button className="ds-link" onClick={() => void openUrl(url)}>
          {openLinkLabel}
        </button>
        {footerExtra}
        <span className="ds-url muted">{url}</span>
      </footer>
    </div>
  );
}
