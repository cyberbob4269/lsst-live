//! Generic sidecar process management, adapted from the vera-home Tauri shell.
//!
//! Helpers to spawn a child process by path (with args/env), poll a TCP-HTTP
//! `GET /healthz` endpoint until it answers, and shut the process tree down
//! gracefully. Wired up in Phase 4 when the agent-core/dashboard backend
//! ships next to the exe — hence `allow(dead_code)` for now.

#![allow(dead_code)]

use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::Path;
use std::process::{Child, Command};
use std::time::{Duration, Instant};

/// Spawn the executable at `path` with CLI args and extra environment vars.
///
/// On Windows the child is started in a new process group so a later
/// `taskkill /T` targets exactly this tree and nothing else.
pub fn spawn_child(
    path: &Path,
    args: &[&str],
    env: &[(String, String)],
) -> std::io::Result<Child> {
    let mut cmd = Command::new(path);
    cmd.args(args);
    for (key, value) in env {
        cmd.env(key, value);
    }

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        cmd.creation_flags(CREATE_NEW_PROCESS_GROUP);
    }

    cmd.spawn()
}

/// Single-shot health check: raw TCP HTTP GET against `127.0.0.1:{port}{path}`.
/// True when the response looks like a 200 or carries a `"healthy"` payload.
pub fn healthz_ok(port: u16, path: &str) -> bool {
    let addr = format!("127.0.0.1:{port}");
    let mut stream = match TcpStream::connect_timeout(
        &addr.parse().expect("valid loopback address"),
        Duration::from_secs(1),
    ) {
        Ok(s) => s,
        Err(_) => return false,
    };
    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
    let req = format!("GET {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n");
    if stream.write_all(req.as_bytes()).is_err() {
        return false;
    }
    let mut buf = [0u8; 1024];
    let Ok(n) = stream.read(&mut buf) else {
        return false;
    };
    let text = String::from_utf8_lossy(&buf[..n]);
    text.contains(" 200 ") || text.contains("\"healthy\"")
}

/// Poll the health endpoint every `interval` until it answers or `timeout`
/// elapses. Returns true if the service came up in time.
pub fn wait_for_healthz(port: u16, path: &str, timeout: Duration, interval: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    loop {
        if healthz_ok(port, path) {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(interval);
    }
}

/// Best-effort graceful shutdown of the child's whole process tree.
///
/// Windows: `taskkill /T` first (gives the child a chance to run cleanup /
/// atexit handlers), then `taskkill /T /F` if anything survives `grace`.
/// Unix:    SIGTERM, wait, then SIGKILL.
pub fn kill_process_tree(child: &mut Child, grace: Duration) {
    let pid = child.id();
    eprintln!("[vera] shutting down sidecar (pid {pid})");

    #[cfg(target_os = "windows")]
    {
        let _ = Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T"])
            .status();
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = Command::new("kill")
            .args(["-TERM", &pid.to_string()])
            .status();
    }

    // Wait for graceful exit.
    let deadline = Instant::now() + grace;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                eprintln!("[vera] sidecar exited cleanly: {status}");
                return;
            }
            Ok(None) => {
                if Instant::now() >= deadline {
                    break;
                }
                std::thread::sleep(Duration::from_millis(200));
            }
            Err(e) => {
                eprintln!("[vera] try_wait failed: {e}");
                break;
            }
        }
    }

    // Force kill whatever survived.
    eprintln!("[vera] sidecar did not exit gracefully — force killing tree");
    #[cfg(target_os = "windows")]
    {
        let _ = Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .status();
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = child.kill();
    }
    let _ = child.wait();
}
