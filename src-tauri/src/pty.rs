//! PTY sessions for the embedded terminal (Phase 2).
//!
//! Each session owns a ConPTY (Windows) / PTY (unix) pair via `portable-pty`.
//! A reader thread per session streams child output and emits Tauri events:
//!
//!   `pty-output`  payload `{ id: u64, data: string }`
//!                 `data` is a lossy-UTF-8 decode of the raw chunk — a split
//!                 multi-byte codepoint may surface as U+FFFD; the terminal
//!                 tolerates this.
//!   `pty-exit`    payload `{ id: u64 }` — emitted when the reader thread sees
//!                 EOF/error (child died) AND the session was still registered
//!                 (i.e. not explicitly killed via `pty_kill`).
//!
//! All sessions are killed on app exit (see `lib.rs`).

use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, State};

struct PtySession {
    writer: Box<dyn Write + Send>,
    child: Box<dyn ChildKiller + Send + Sync>,
    master: Box<dyn MasterPty + Send>,
}

/// Shared PTY session registry, held in Tauri state as `Arc<PtyManager>`.
pub struct PtyManager {
    sessions: Mutex<HashMap<u64, PtySession>>,
    next_id: AtomicU64,
}

#[derive(Serialize, Clone)]
struct PtyOutput {
    id: u64,
    data: String,
}

#[derive(Serialize, Clone)]
struct PtyExit {
    id: u64,
}

impl PtyManager {
    pub fn new() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
            next_id: AtomicU64::new(0),
        }
    }

    /// Kill every live session. Called on app exit.
    pub fn kill_all(&self) {
        let Ok(mut sessions) = self.sessions.lock() else {
            return;
        };
        for (id, mut session) in sessions.drain() {
            eprintln!("[vera] killing pty session {id}");
            // ChildKiller exposes kill but not wait; the reader thread's EOF
            // handles exit detection, and on Windows there is no zombie risk.
            let _ = session.child.kill();
        }
    }
}

#[cfg(target_os = "windows")]
fn default_shell() -> String {
    "powershell.exe".to_string()
}

#[cfg(not(target_os = "windows"))]
fn default_shell() -> String {
    std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string())
}

#[tauri::command]
pub fn pty_spawn(
    app: AppHandle,
    state: State<'_, Arc<PtyManager>>,
    shell: Option<String>,
    cwd: String,
    cols: u16,
    rows: u16,
) -> Result<u64, String> {
    let shell = shell
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(default_shell);
    let cols = cols.max(2);
    let rows = rows.max(1);

    let pair = native_pty_system()
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("openpty failed: {e}"))?;

    let mut cmd = CommandBuilder::new(&shell);
    cmd.cwd(&cwd);
    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("failed to spawn {shell}: {e}"))?;
    // Drop our copy of the slave so the reader sees EOF when the child exits.
    drop(pair.slave);

    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("failed to clone pty reader: {e}"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("failed to take pty writer: {e}"))?;

    let id = state.next_id.fetch_add(1, Ordering::SeqCst) + 1;
    state
        .sessions
        .lock()
        .map_err(|e| e.to_string())?
        .insert(id, PtySession { writer, child, master: pair.master });

    let manager = state.inner().clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let data = String::from_utf8_lossy(&buf[..n]).to_string();
                    if app.emit("pty-output", PtyOutput { id, data }).is_err() {
                        break; // webview gone — nothing left to stream to
                    }
                }
                Err(_) => break,
            }
        }
        // Child exited or PTY closed. Only announce if the session was still
        // registered — an explicit pty_kill removes it first and stays silent.
        let removed = manager
            .sessions
            .lock()
            .map(|mut sessions| sessions.remove(&id))
            .unwrap_or(None);
        if removed.is_some() {
            let _ = app.emit("pty-exit", PtyExit { id });
        }
    });

    Ok(id)
}

#[tauri::command]
pub fn pty_write(
    state: State<'_, Arc<PtyManager>>,
    id: u64,
    data: String,
) -> Result<(), String> {
    let mut sessions = state.sessions.lock().map_err(|e| e.to_string())?;
    let session = sessions
        .get_mut(&id)
        .ok_or_else(|| format!("no pty session {id}"))?;
    session
        .writer
        .write_all(data.as_bytes())
        .and_then(|()| session.writer.flush())
        .map_err(|e| format!("pty write failed: {e}"))
}

#[tauri::command]
pub fn pty_resize(
    state: State<'_, Arc<PtyManager>>,
    id: u64,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let sessions = state.sessions.lock().map_err(|e| e.to_string())?;
    let session = sessions
        .get(&id)
        .ok_or_else(|| format!("no pty session {id}"))?;
    session
        .master
        .resize(PtySize {
            rows: rows.max(1),
            cols: cols.max(2),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("pty resize failed: {e}"))
}

#[tauri::command]
pub fn pty_kill(state: State<'_, Arc<PtyManager>>, id: u64) -> Result<(), String> {
    let mut session = state
        .sessions
        .lock()
        .map_err(|e| e.to_string())?
        .remove(&id)
        .ok_or_else(|| format!("no pty session {id}"))?;
    let _ = session.child.kill();
    Ok(())
}
