// Typed wrappers for the Phase 2 Tauri commands (see src-tauri/src/pty.rs and
// fs_cmds.rs). All fs paths are confined to the workspace root by the backend.

import { invoke } from "@tauri-apps/api/core";

export interface DirEntry {
  name: string;
  path: string;
  is_dir: boolean;
  size: number;
}

export interface FileContent {
  content: string;
  truncated: boolean;
}

/** Payload of the `pty-output` event. `data` is a lossy-UTF-8 chunk. */
export interface PtyOutput {
  id: number;
  data: string;
}

/** Payload of the `pty-exit` event. */
export interface PtyExit {
  id: number;
}

export const fsWorkspaceRoot = () => invoke<string>("fs_workspace_root");

export const fsListDir = (path: string) => invoke<DirEntry[]>("fs_list_dir", { path });

export const fsReadFile = (path: string) => invoke<FileContent>("fs_read_file", { path });

export const fsWriteFile = (path: string, content: string) =>
  invoke<void>("fs_write_file", { path, content });

/** Create a workspace directory (and missing parents). */
export const fsEnsureDir = (path: string) => invoke<void>("fs_ensure_dir", { path });

/** Read a binary workspace file (media), returned base64-encoded. */
export const fsReadBinary = (path: string) => invoke<string>("fs_read_binary", { path });

/** Write base64-decoded bytes to a workspace file; parent dirs are created. */
export const fsWriteBinary = (path: string, base64: string) =>
  invoke<void>("fs_write_binary", { path, base64 });

export const ptySpawn = (cwd: string, cols: number, rows: number, shell?: string) =>
  invoke<number>("pty_spawn", { shell: shell ?? null, cwd, cols, rows });

export const ptyWrite = (id: number, data: string) => invoke<void>("pty_write", { id, data });

export const ptyResize = (id: number, cols: number, rows: number) =>
  invoke<void>("pty_resize", { id, cols, rows });

export const ptyKill = (id: number) => invoke<void>("pty_kill", { id });
