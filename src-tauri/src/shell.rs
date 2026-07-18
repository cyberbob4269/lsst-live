//! Non-interactive shell execution for the AI agent's `run_shell` tool
//! (Phase 3). This is deliberately separate from `pty.rs`: no terminal
//! session, no events — one command in, one result out.
//!
//! Commands run via `powershell.exe -NoProfile -Command <command>` with the
//! working directory confined to the workspace root (same guard as
//! `fs_cmds`). Output is capped per stream and the child is killed when it
//! overruns the timeout, so a stuck command can't hang the agent loop.

use serde::Serialize;
use std::process::Stdio;
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncReadExt};

use crate::fs_cmds;

/// Per-stream output cap; beyond this we keep draining the pipe (so the
/// child never blocks on a full buffer) but discard the bytes.
const MAX_STREAM_BYTES: usize = 64 * 1024;
const DEFAULT_TIMEOUT_MS: u64 = 30_000;
const MAX_TIMEOUT_MS: u64 = 120_000;

#[derive(Serialize)]
pub struct ShellResult {
    stdout: String,
    stderr: String,
    /// Process exit code; `null` when the child was killed on timeout.
    code: Option<i32>,
}

/// Read `reader` to EOF, retaining at most `MAX_STREAM_BYTES` and appending
/// a truncation marker when more data arrived.
async fn read_capped<R: AsyncRead + Unpin>(mut reader: R) -> String {
    let mut kept: Vec<u8> = Vec::new();
    let mut truncated = false;
    let mut buf = [0u8; 8192];
    loop {
        match reader.read(&mut buf).await {
            Ok(0) => break,
            Ok(n) => {
                let room = MAX_STREAM_BYTES.saturating_sub(kept.len());
                if room > 0 {
                    kept.extend_from_slice(&buf[..n.min(room)]);
                }
                if n > room {
                    truncated = true;
                }
            }
            Err(_) => break,
        }
    }
    let mut s = String::from_utf8_lossy(&kept).to_string();
    if truncated {
        s.push_str("\n… [output truncated at 64 KB]");
    }
    s
}

#[tauri::command]
pub async fn shell_exec(
    command: String,
    cwd: Option<String>,
    timeout_ms: Option<u64>,
) -> Result<ShellResult, String> {
    let dir = match cwd {
        Some(c) if !c.trim().is_empty() => fs_cmds::resolve_in_workspace(&c)?,
        _ => fs_cmds::workspace_root()?,
    };
    if !dir.is_dir() {
        return Err(format!(
            "cwd is not a directory: {}",
            fs_cmds::normalize(&dir)
        ));
    }
    let timeout = Duration::from_millis(
        timeout_ms
            .unwrap_or(DEFAULT_TIMEOUT_MS)
            .clamp(1, MAX_TIMEOUT_MS),
    );

    // `; exit $LASTEXITCODE` propagates the exit code of native commands
    // (git, npm, …) — powershell itself would otherwise exit 0 on their
    // failure. For pure-cmdlet commands $LASTEXITCODE is unset → exit 0.
    let wrapped = format!("{command}; exit $LASTEXITCODE");

    let mut child = tokio::process::Command::new("powershell.exe")
        .args(["-NoProfile", "-Command", &wrapped])
        .current_dir(&dir)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("cannot spawn powershell: {e}"))?;

    let stdout = child.stdout.take().expect("stdout piped");
    let stderr = child.stderr.take().expect("stderr piped");
    // Drain both streams concurrently while we wait on the child.
    let out_handle = tokio::spawn(read_capped(stdout));
    let err_handle = tokio::spawn(read_capped(stderr));

    let mut killed = false;
    let code = match tokio::time::timeout(timeout, child.wait()).await {
        Ok(Ok(status)) => status.code(),
        Ok(Err(e)) => return Err(format!("cannot wait on powershell: {e}")),
        Err(_) => {
            killed = true;
            let _ = child.kill().await;
            None
        }
    };

    let stdout = out_handle.await.map_err(|e| e.to_string())?;
    let mut stderr = err_handle.await.map_err(|e| e.to_string())?;
    if killed {
        let note = format!(
            "[vera] command killed after {}s timeout",
            timeout.as_secs()
        );
        if stderr.is_empty() {
            stderr = note;
        } else {
            stderr.push('\n');
            stderr.push_str(&note);
        }
    }

    Ok(ShellResult {
        stdout,
        stderr,
        code,
    })
}
