// Typed wrappers for the Phase 5 Tauri commands (see src-tauri/src/
// postiz.rs). Docker owns the stack; the view polls status and toggles
// start/stop — no shutdown semantics on the app side.

import { invoke } from "@tauri-apps/api/core";

export type PostizState = "running" | "stopped" | "unknown";

export interface PostizStatus {
  /** `docker --version` succeeded. */
  dockerAvailable: boolean;
  state: PostizState;
  /** http://localhost:4007/ answered with a 2xx/3xx. */
  healthy: boolean;
  /** packaging/postiz/.env exists (required by postiz_start). */
  envPresent: boolean;
  /** Ring buffer of recent docker compose output. */
  lastLog: string[];
}

export const postizStatus = () => invoke<PostizStatus>("postiz_status");

export const postizStart = () => invoke<PostizStatus>("postiz_start");

export const postizStop = () => invoke<PostizStatus>("postiz_stop");
