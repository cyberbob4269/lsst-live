//! Vera@Home backend lifecycle for the Deep Space view (Phase 4).
//!
//! The deep-space dashboard is a same-origin web app served by the vera-home
//! Python backend on `127.0.0.1:8765`; the frontend embeds it in an iframe, so
//! this module only has to guarantee the backend is up. Three commands:
//!
//!   `vera_backend_start`  — adopt-don't-duplicate: probe `/healthz` first and
//!                           report `external` when an instance is already
//!                           live; otherwise spawn `scripts/launch_backend.py`
//!                           with the vera-home checkout as cwd (venv python
//!                           when present, else `python` on PATH).
//!   `vera_backend_stop`   — kill the process tree we spawned (and ONLY that;
//!                           external instances are never touched).
//!   `vera_backend_status` — fresh healthz probe + tracked pid + a small ring
//!                           buffer of the launcher's stdout/stderr for the
//!                           error view.
//!
//! On app exit `shutdown` kills the self-spawned tree (see `lib.rs`).

use serde::Serialize;
use std::collections::VecDeque;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::State;

use crate::sidecar;

const HEALTH_PORT: u16 = 8765;
const HEALTH_PATH: &str = "/healthz";
const MAX_LOG_LINES: usize = 50;
/// Grace period for the launcher's own cleanup (its children get SIGTERM via
/// taskkill /T first) before the tree is force-killed.
const KILL_GRACE: Duration = Duration::from_secs(5);

#[derive(Serialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum BackendMode {
    /// Healthy backend we did not spawn — adopted, never killed by us.
    External,
    /// Spawned by us (may still be starting up — check `healthy`).
    Spawned,
    Stopped,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackendStatus {
    mode: BackendMode,
    healthy: bool,
    /// Pid of the launcher process — only set while `mode == "spawned"`.
    pid: Option<u32>,
    last_log: Vec<String>,
}

/// Shared backend state, held in Tauri state as `Arc<VeraBackendManager>`.
/// The log buffer is a separate `Arc` so the pipe-reader threads can push
/// lines without taking the child lock.
pub struct VeraBackendManager {
    child: Mutex<Option<Child>>,
    log: Arc<Mutex<VecDeque<String>>>,
    /// Last vera-home path that spawned successfully — Restart reuses it.
    last_home: Mutex<Option<PathBuf>>,
}

impl VeraBackendManager {
    pub fn new() -> Self {
        Self {
            child: Mutex::new(None),
            log: Arc::new(Mutex::new(VecDeque::new())),
            last_home: Mutex::new(None),
        }
    }

    fn push_log(&self, line: String) {
        push_log(&self.log, line);
    }

    /// Reap the tracked child if it exited on its own (crash / child of the
    /// launcher died), so `status` stops reporting it as spawned.
    fn reap_exited(&self) {
        let Ok(mut guard) = self.child.lock() else { return };
        let exited = match guard.as_mut() {
            Some(child) => matches!(child.try_wait(), Ok(Some(_))),
            None => false,
        };
        if exited {
            if let Some(mut child) = guard.take() {
                let status = child.try_wait().ok().flatten();
                self.push_log(format!("[vera] backend launcher exited: {status:?}"));
            }
        }
    }

    /// Fresh snapshot: reaps a dead launcher, probes /healthz, picks the mode.
    pub fn status(&self) -> BackendStatus {
        self.reap_exited();
        let pid = self
            .child
            .lock()
            .ok()
            .and_then(|guard| guard.as_ref().map(|c| c.id()));
        let healthy = sidecar::healthz_ok(HEALTH_PORT, HEALTH_PATH);
        let mode = if pid.is_some() {
            BackendMode::Spawned
        } else if healthy {
            BackendMode::External
        } else {
            BackendMode::Stopped
        };
        let last_log = self
            .log
            .lock()
            .map(|guard| guard.iter().cloned().collect())
            .unwrap_or_default();
        BackendStatus {
            mode,
            healthy,
            pid,
            last_log,
        }
    }

    pub fn start(&self, vera_home_path: Option<String>) -> Result<BackendStatus, String> {
        self.reap_exited();

        // Already tracking a live launcher → just report.
        if self.child.lock().map(|c| c.is_some()).unwrap_or(false) {
            return Ok(self.status());
        }

        // Adopt-don't-duplicate: something is already serving :8765.
        if sidecar::healthz_ok(HEALTH_PORT, HEALTH_PATH) {
            self.push_log("[vera] backend already healthy on :8765 — adopting external instance".into());
            return Ok(self.status());
        }

        let home = vera_home_path
            .filter(|p| !p.trim().is_empty())
            .map(PathBuf::from)
            .or_else(|| self.last_home.lock().ok().and_then(|g| g.clone()));

        let home = match home {
            Some(h) if !h.as_os_str().is_empty() => h,
            _ => {
                return Err(
                    "No vera-home path configured — set it in Settings before starting the backend"
                        .into(),
                );
            }
        };

        let script = home.join("scripts").join("launch_backend.py");
        if !script.is_file() {
            return Err(format!(
                "scripts/launch_backend.py not found under {} — check the vera-home path",
                home.display()
            ));
        }

        let python = resolve_python(&home);
        self.push_log(format!(
            "[vera] launching {} {} (cwd {})",
            python.display(),
            script.display(),
            home.display()
        ));
        let mut child = spawn_launcher(&python, &script, &home)
            .map_err(|e| format!("failed to spawn {}: {e}", python.display()))?;

        if let Some(stdout) = child.stdout.take() {
            pipe_to_log(stdout, self.log.clone());
        }
        if let Some(stderr) = child.stderr.take() {
            pipe_to_log(stderr, self.log.clone());
        }

        let pid = child.id();
        self.push_log(format!("[vera] backend launcher pid {pid}"));
        if let Ok(mut guard) = self.child.lock() {
            *guard = Some(child);
        }
        if let Ok(mut guard) = self.last_home.lock() {
            *guard = Some(home);
        }

        // Brief settle so a launcher that dies instantly (missing deps, bad
        // venv) surfaces in the returned status instead of a misleading
        // "starting". The 2.5 s frontend poll handles the normal slow boot.
        std::thread::sleep(Duration::from_millis(800));
        Ok(self.status())
    }

    /// Stop the launcher we spawned. External instances are never touched.
    pub fn stop(&self) -> BackendStatus {
        let child = self.child.lock().ok().and_then(|mut g| g.take());
        if let Some(mut child) = child {
            self.push_log("[vera] stopping backend launcher…".into());
            sidecar::kill_process_tree(&mut child, KILL_GRACE);
            self.push_log("[vera] backend launcher stopped".into());
        }
        self.status()
    }

    /// App-exit cleanup: kill only a self-spawned tree.
    pub fn shutdown(&self) {
        if let Ok(mut guard) = self.child.lock() {
            if let Some(mut child) = guard.take() {
                sidecar::kill_process_tree(&mut child, KILL_GRACE);
            }
        }
    }
}

fn push_log(log: &Mutex<VecDeque<String>>, line: String) {
    if let Ok(mut guard) = log.lock() {
        while guard.len() >= MAX_LOG_LINES {
            guard.pop_front();
        }
        guard.push_back(line);
    }
}

/// Prefer the vera-home venv interpreter (its deps are installed there);
/// fall back to `python` on PATH like the reference shell did.
fn resolve_python(home: &Path) -> PathBuf {
    for candidate in [
        home.join(".venv").join("Scripts").join("python.exe"),
        home.join(".venv").join("bin").join("python"),
    ] {
        if candidate.is_file() {
            return candidate;
        }
    }
    PathBuf::from("python")
}

/// Spawn the launcher with piped stdout/stderr (drained into the log ring
/// buffer) and, on Windows, in its own process group so `taskkill /T` in
/// `sidecar::kill_process_tree` targets exactly this tree.
fn spawn_launcher(python: &Path, script: &Path, home: &Path) -> std::io::Result<Child> {
    let mut cmd = Command::new(python);
    cmd.arg(script)
        .current_dir(home)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        cmd.creation_flags(CREATE_NEW_PROCESS_GROUP);
    }

    cmd.spawn()
}

/// Stream child output line-by-line into the shared ring buffer until EOF.
fn pipe_to_log<R: Read + Send + 'static>(reader: R, log: Arc<Mutex<VecDeque<String>>>) {
    std::thread::spawn(move || {
        for line in BufReader::new(reader).lines() {
            match line {
                Ok(line) => push_log(&log, line),
                Err(_) => break,
            }
        }
    });
}

// Blocking work runs via spawn_blocking so the multi-second healthz probe /
// tree-kill never stalls the async runtime. Commands stay thin wrappers.

#[tauri::command]
pub async fn vera_backend_start(
    state: State<'_, Arc<VeraBackendManager>>,
    vera_home_path: Option<String>,
) -> Result<BackendStatus, String> {
    let mgr = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || mgr.start(vera_home_path))
        .await
        .map_err(|e| e.to_string())?
}

/// Returns the post-stop status (spec allows void; the status saves the
/// frontend a follow-up `vera_backend_status` roundtrip).
#[tauri::command]
pub async fn vera_backend_stop(
    state: State<'_, Arc<VeraBackendManager>>,
) -> Result<BackendStatus, String> {
    let mgr = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || mgr.stop())
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn vera_backend_status(
    state: State<'_, Arc<VeraBackendManager>>,
) -> Result<BackendStatus, String> {
    let mgr = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || mgr.status())
        .await
        .map_err(|e| e.to_string())
}
