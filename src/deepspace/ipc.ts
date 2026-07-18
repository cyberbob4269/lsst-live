// Typed wrappers for the Phase 4 Tauri commands (see src-tauri/src/
// vera_backend.rs). The backend lifecycle lives entirely in Rust state;
// the view just polls status and toggles start/stop.

import { invoke } from "@tauri-apps/api/core";

export type BackendMode = "external" | "spawned" | "stopped";

export interface BackendStatus {
  mode: BackendMode;
  healthy: boolean;
  /** Pid of the launcher we spawned; null for external/stopped. */
  pid: number | null;
  /** Ring buffer (last ~50 lines) of launcher stdout/stderr. */
  lastLog: string[];
}

export const veraBackendStart = (veraHomePath?: string) =>
  invoke<BackendStatus>("vera_backend_start", {
    veraHomePath: veraHomePath ?? null,
  });

export const veraBackendStop = () => invoke<BackendStatus>("vera_backend_stop");

export const veraBackendStatus = () => invoke<BackendStatus>("vera_backend_status");
