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

/** Phase 7 (first-run): render `packaging/postiz/.env` from `.env.example`
 *  with the given JWT secret and optional X credentials substituted in (all
 *  other template lines stay byte-identical). Refuses to clobber an existing
 *  .env unless `overwrite` is true. Returns the path written. */
export const postizWriteEnv = (args: {
  jwtSecret: string;
  xApiKey?: string | null;
  xApiSecret?: string | null;
  overwrite: boolean;
}) =>
  invoke<string>("postiz_write_env", {
    jwtSecret: args.jwtSecret,
    xApiKey: args.xApiKey ?? null,
    xApiSecret: args.xApiSecret ?? null,
    overwrite: args.overwrite,
  });
