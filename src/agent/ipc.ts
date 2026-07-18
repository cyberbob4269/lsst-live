// Typed wrappers for the Phase 3 Tauri commands (see src-tauri/src/
// keyring_cmds.rs and shell.rs). API keys live in the OS credential store;
// shell_exec is the non-interactive counterpart of the PTY commands.

import { invoke } from "@tauri-apps/api/core";

export interface KeyStatus {
  provider: string;
  has_key: boolean;
}

export interface ShellResult {
  stdout: string;
  stderr: string;
  /** null when the process was killed on timeout. */
  code: number | null;
}

export const keySet = (provider: string, apiKey: string) =>
  invoke<void>("key_set", { provider, apiKey });

export const keyGet = (provider: string) =>
  invoke<string | null>("key_get", { provider });

export const keyDelete = (provider: string) =>
  invoke<void>("key_delete", { provider });

export const keyStatus = () => invoke<KeyStatus[]>("key_status");

export const shellExec = (command: string, cwd?: string, timeoutMs?: number) =>
  invoke<ShellResult>("shell_exec", {
    command,
    cwd: cwd ?? null,
    timeoutMs: timeoutMs ?? null,
  });
