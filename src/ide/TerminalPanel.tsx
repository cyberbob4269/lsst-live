import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { listen } from "@tauri-apps/api/event";
import "@xterm/xterm/css/xterm.css";
import { ptyKill, ptyResize, ptySpawn, ptyWrite, type PtyExit, type PtyOutput } from "./ipc";

interface TerminalPanelProps {
  /** Working directory for the shell (the workspace root). */
  cwd: string;
  /** When collapsed the xterm host is display:none — skip fit/resize then. */
  collapsed: boolean;
  onAliveChange(alive: boolean): void;
  onError(message: string): void;
}

/**
 * Embedded terminal: xterm.js front, real PTY (powershell.exe) behind it via
 * the pty_* commands. The panel stays mounted while collapsed so the shell
 * keeps running; the IDE view itself also stays mounted when hidden
 * (keep-alive in App.tsx), so the PTY survives view switches and is disposed
 * only on app exit.
 */
export default function TerminalPanel({ cwd, collapsed, onAliveChange, onError }: TerminalPanelProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const ptyIdRef = useRef<number | null>(null);
  const startPtyRef = useRef<(() => void) | null>(null);
  const collapsedRef = useRef(collapsed);
  const [exited, setExited] = useState(false);

  // Mount once: create xterm, spawn the PTY, wire events and resize.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: "Cascadia Code, Consolas, monospace",
      theme: {
        background: "#05070f",
        foreground: "#dbe4ff",
        cursor: "#22d3ee",
        selectionBackground: "rgba(99, 102, 241, 0.35)",
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    try {
      fit.fit();
    } catch {
      // zero-size host during layout — the ResizeObserver will refit
    }
    termRef.current = term;
    fitRef.current = fit;

    let disposed = false;
    const unlisteners: Array<() => void> = [];

    const startPty = async () => {
      try {
        const id = await ptySpawn(cwd, term.cols, term.rows);
        if (disposed) {
          ptyKill(id).catch(() => undefined);
          return;
        }
        ptyIdRef.current = id;
        setExited(false);
        onAliveChange(true);
      } catch (err) {
        onError(`Terminal spawn failed: ${String(err)}`);
        setExited(true);
      }
    };
    startPtyRef.current = startPty;
    startPty();

    listen<PtyOutput>("pty-output", (event) => {
      if (event.payload.id === ptyIdRef.current) {
        term.write(event.payload.data);
      }
    }).then((un) => {
      if (disposed) un();
      else unlisteners.push(un);
    });

    listen<PtyExit>("pty-exit", (event) => {
      if (event.payload.id === ptyIdRef.current) {
        ptyIdRef.current = null;
        term.write("\r\n\x1b[90m[process exited]\x1b[0m\r\n");
        setExited(true);
        onAliveChange(false);
      }
    }).then((un) => {
      if (disposed) un();
      else unlisteners.push(un);
    });

    const dataDisposable = term.onData((data) => {
      const id = ptyIdRef.current;
      if (id != null) ptyWrite(id, data).catch(() => undefined);
    });

    const observer = new ResizeObserver(() => {
      if (collapsedRef.current) return;
      try {
        fit.fit();
      } catch {
        return;
      }
      const id = ptyIdRef.current;
      if (id != null) ptyResize(id, term.cols, term.rows).catch(() => undefined);
    });
    observer.observe(host);

    return () => {
      disposed = true;
      observer.disconnect();
      dataDisposable.dispose();
      unlisteners.forEach((un) => un());
      const id = ptyIdRef.current;
      ptyIdRef.current = null;
      if (id != null) ptyKill(id).catch(() => undefined);
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
      onAliveChange(false);
    };
  }, [cwd, onAliveChange, onError]);

  // Refit when the panel is re-expanded (its size changed while hidden).
  useEffect(() => {
    collapsedRef.current = collapsed;
    if (collapsed) return;
    requestAnimationFrame(() => {
      const term = termRef.current;
      const fit = fitRef.current;
      if (!term || !fit) return;
      try {
        fit.fit();
      } catch {
        return;
      }
      const id = ptyIdRef.current;
      if (id != null) ptyResize(id, term.cols, term.rows).catch(() => undefined);
    });
  }, [collapsed]);

  const restart = () => {
    termRef.current?.reset();
    startPtyRef.current?.();
  };

  return (
    <div className="terminal-panel">
      <div className="terminal-host" ref={hostRef} />
      {exited && (
        <div className="terminal-overlay">
          <button className="term-restart" onClick={restart}>
            Restart shell
          </button>
        </div>
      )}
    </div>
  );
}
