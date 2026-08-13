// BackendFrame — embeds a vera-home web page from the local backend
// (http://127.0.0.1:8765) when a vera-home path is configured, or from the
// public GitHub Pages labs when no path is set or the local backend fails.

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { loadSettingsFile } from "../agent/settingsStore";
import {
  veraBackendStart,
  veraBackendStatus,
  veraBackendStop,
  type BackendStatus,
} from "./ipc";
import { FEATURED_PUBLIC_LABS, publicLabUrl } from "./publicLabs";

const BACKEND_ORIGIN = "http://127.0.0.1:8765";
const AUTOSTART_KEY = "vera.deepspace.autostart.v1";
const POLL_MS = 2500;

type UiState = "idle" | "starting" | "live" | "public" | "error";

function loadAutoStart(): boolean {
  try {
    return localStorage.getItem(AUTOSTART_KEY) !== "0";
  } catch {
    return true;
  }
}

export interface BackendFrameProps {
  title: string;
  path: string;
  visible: boolean;
  openLinkLabel?: string;
  footerExtra?: ReactNode;
}

export default function BackendFrame({
  title,
  path,
  visible,
  openLinkLabel = "Open in browser",
  footerExtra,
}: BackendFrameProps) {
  const localUrl = `${BACKEND_ORIGIN}${path}`;
  const publicUrl = publicLabUrl(path);

  const [veraHomePath, setVeraHomePath] = useState<string | null>(null);
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [status, setStatus] = useState<BackendStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [autoStart, setAutoStart] = useState<boolean>(loadAutoStart);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());
  const [usePublicFallback, setUsePublicFallback] = useState(false);
  const wantedRef = useRef(false);

  const hasLocalPath = Boolean(veraHomePath?.trim());
  const canUsePublic = Boolean(publicUrl);

  useEffect(() => {
    let cancelled = false;
    loadSettingsFile()
      .then((file) => {
        if (cancelled) return;
        const pathValue = file?.backend.veraHomePath?.trim() || null;
        setVeraHomePath(pathValue);
        setSettingsLoaded(true);
      })
      .catch((err) => {
        console.error("[lsst-live] settings load failed", err);
        if (!cancelled) setSettingsLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Initial status + auto-start when a local path is configured.
  useEffect(() => {
    if (!visible || !settingsLoaded || !hasLocalPath) return;
    let cancelled = false;
    (async () => {
      try {
        const s = await veraBackendStatus();
        if (cancelled) return;
        setStatus(s);
        if (autoStart && s.mode === "stopped") {
          wantedRef.current = true;
          setStartedAt(Date.now());
          setStatus(await veraBackendStart(veraHomePath ?? undefined));
        }
      } catch (err) {
        if (!cancelled) setError(String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [autoStart, visible, settingsLoaded, hasLocalPath, veraHomePath]);

  useEffect(() => {
    if (!visible || !hasLocalPath) return;
    veraBackendStatus()
      .then(setStatus)
      .catch((err) => console.error("[lsst-live] vera_backend_status failed", err));
    const timer = setInterval(() => {
      veraBackendStatus()
        .then(setStatus)
        .catch((err) => console.error("[lsst-live] vera_backend_status failed", err));
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [visible, hasLocalPath]);

  const died = wantedRef.current && status?.mode === "stopped" && !status.healthy;
  const localLive = hasLocalPath && status?.healthy && !usePublicFallback;

  const uiState: UiState = !hasLocalPath || usePublicFallback
    ? canUsePublic
      ? "public"
      : "error"
    : error || died
      ? canUsePublic
        ? "public"
        : "error"
      : localLive
        ? "live"
        : wantedRef.current || status?.mode === "spawned"
          ? "starting"
          : "idle";

  useEffect(() => {
    if (uiState !== "starting" || !visible) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [uiState, visible]);

  const doStart = useCallback(async () => {
    if (!hasLocalPath) return;
    setBusy(true);
    setError(null);
    setUsePublicFallback(false);
    wantedRef.current = true;
    setStartedAt(Date.now());
    try {
      setStatus(await veraBackendStart(veraHomePath ?? undefined));
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }, [hasLocalPath, veraHomePath]);

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
    if (!hasLocalPath) return;
    setBusy(true);
    setError(null);
    setUsePublicFallback(false);
    wantedRef.current = true;
    setStartedAt(Date.now());
    try {
      await veraBackendStop();
      setStatus(await veraBackendStart(veraHomePath ?? undefined));
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }, [hasLocalPath, veraHomePath]);

  const toggleAutoStart = useCallback((value: boolean) => {
    setAutoStart(value);
    try {
      localStorage.setItem(AUTOSTART_KEY, value ? "1" : "0");
    } catch {
      // Storage unavailable — the toggle just won't persist.
    }
  }, []);

  const openPublic = useCallback(() => {
    if (publicUrl) void openUrl(publicUrl);
  }, [publicUrl]);

  const chipText =
    uiState === "live"
      ? status?.mode === "external"
        ? "Live (external)"
        : "Live (spawned)"
      : uiState === "public"
        ? "Public labs"
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

  const frameUrl = uiState === "public" && publicUrl ? publicUrl : localUrl;
  const pathLabel = hasLocalPath ? veraHomePath : "Not configured — using public labs";

  return (
    <div className="ds-wrap">
      <header className="ds-toolbar">
        <span className={`ds-chip is-${uiState === "public" ? "live" : uiState}`}>{chipText}</span>
        {hasLocalPath && (
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
        )}
        <span className="ds-path muted" title={pathLabel ?? ""}>
          {pathLabel}
        </span>
        {hasLocalPath && (
          <label className="chat-toggle ds-autostart">
            <input
              type="checkbox"
              checked={autoStart}
              onChange={(e) => toggleAutoStart(e.target.checked)}
            />
            Auto-start on open
          </label>
        )}
      </header>

      <div className="ds-main">
        {(uiState === "live" || uiState === "public") && (
          <iframe className="ds-iframe" src={frameUrl} title={title} />
        )}

        {uiState === "starting" && (
          <div className="pane-body muted">
            <div className="ds-starting">
              <span className="spinner" />
              <p>Waiting for the dashboard backend on 127.0.0.1:8765…</p>
              <p className="muted">
                {elapsed}s elapsed — first launch can take ~30 s while the stream ingest connects.
              </p>
            </div>
          </div>
        )}

        {uiState === "error" && (
          <div className="ds-error">
            <p className="ds-error-title">
              {hasLocalPath
                ? "Backend failed to start."
                : "No local backend path configured."}
            </p>
            {hasLocalPath && <pre className="ds-log">{logText}</pre>}
            {!hasLocalPath && (
              <p className="muted soc-p">
                Set the vera-home path in Settings to run labs locally, or open the public hosted
                labs below.
              </p>
            )}
            <div className="welcome-actions">
              {hasLocalPath && (
                <button className="settings-btn" disabled={busy} onClick={() => void doStart()}>
                  Retry
                </button>
              )}
              {canUsePublic && (
                <button
                  className="settings-btn"
                  onClick={() => {
                    setUsePublicFallback(true);
                    setError(null);
                  }}
                >
                  Use public labs
                </button>
              )}
            </div>
            <div className="ds-public-links">
              <p className="settings-label">Public labs</p>
              <ul className="soc-list">
                {FEATURED_PUBLIC_LABS.map((lab) => (
                  <li key={lab.url}>
                    <button className="ds-link" onClick={() => void openUrl(lab.url)}>
                      {lab.label}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        )}

        {uiState === "idle" && (
          <div className="pane-body muted">
            Backend is stopped — press Start to launch {title}.
            {canUsePublic && (
              <>
                {" "}
                <button
                  className="ds-link"
                  onClick={() => {
                    setUsePublicFallback(true);
                  }}
                >
                  Or use public labs
                </button>
              </>
            )}
          </div>
        )}
      </div>

      <footer className="ds-footer">
        <button className="ds-link" onClick={() => void openUrl(frameUrl)}>
          {openLinkLabel}
        </button>
        {canUsePublic && uiState !== "public" && (
          <button className="ds-link" onClick={openPublic}>
            Open public lab
          </button>
        )}
        {footerExtra}
        <span className="ds-url muted">{frameUrl}</span>
      </footer>
    </div>
  );
}
