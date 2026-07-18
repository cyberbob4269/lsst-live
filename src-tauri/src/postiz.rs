//! Postiz docker-compose lifecycle for the Social view (Phase 5).
//!
//! Same manager shape as `vera_backend.rs`, but there is no child process to
//! track — the stack is owned by Docker. Three commands:
//!
//!   `postiz_status` — probes `docker --version` (CLI present), then
//!                     `docker compose -f <postiz dir>/docker-compose.yml ps`
//!                     for container state, then an HTTP GET against
//!                     `http://localhost:4007/` (any 2xx/3xx = healthy; the
//!                     Postiz Next.js app redirects/answers there once up).
//!   `postiz_start`  — `docker compose --env-file <postiz dir>/.env -f
//!                     <postiz dir>/docker-compose.yml up -d`, with clear
//!                     actionable errors when Docker or the .env is missing.
//!   `postiz_stop`   — `docker compose ... down` (NOT `-v`: named volumes
//!                     keep Postgres/Redis data and uploads).
//!
//! `<postiz dir>` resolves (first hit with a docker-compose.yml wins) from:
//! `$VERA_POSTIZ_DIR`, then `<exe dir>/postiz` (packaged installs, where the
//! bundle resources place the stack next to the executable), then the dev
//! fallback `<repo>/packaging/postiz`.
//!
//! The compose project is named `vera-postiz` (top-level `name:` in the
//! compose file), so `ps`/`down` resolve the same project from any cwd.
//! Nothing here is killed on app exit — the stack is meant to keep running.
//!
//! Everything shells out via std::process with timeouts; Docker is expected
//! to be ABSENT on many machines, so every path degrades to a status or an
//! error string, never a panic.

use serde::Serialize;
use std::collections::VecDeque;
use std::io::Read;
use std::net::TcpStream;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::State;

const HEALTH_PORT: u16 = 4007;
const MAX_LOG_LINES: usize = 50;
/// `docker compose up -d` also pulls images on first run — that can take
/// several minutes on a slow link, so this timeout is deliberately generous.
const UP_TIMEOUT: Duration = Duration::from_secs(600);
const DOWN_TIMEOUT: Duration = Duration::from_secs(120);
const PROBE_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Serialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum StackState {
    Running,
    Stopped,
    /// Docker or the daemon didn't answer coherently.
    Unknown,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PostizStatus {
    /// `docker --version` succeeded.
    docker_available: bool,
    state: StackState,
    /// http://localhost:4007/ answered with a 2xx/3xx.
    healthy: bool,
    /// packaging/postiz/.env exists — required by `postiz_start`.
    env_present: bool,
    last_log: Vec<String>,
}

/// Shared Postiz state, held in Tauri state as `Arc<PostizManager>`. Only a
/// log ring buffer — Docker owns the containers, so there is no child to
/// reap and no shutdown hook.
pub struct PostizManager {
    log: Mutex<VecDeque<String>>,
}

impl PostizManager {
    pub fn new() -> Self {
        Self {
            log: Mutex::new(VecDeque::new()),
        }
    }

    fn push_log(&self, line: String) {
        if let Ok(mut guard) = self.log.lock() {
            while guard.len() >= MAX_LOG_LINES {
                guard.pop_front();
            }
            guard.push_back(line);
        }
    }

    fn snapshot_log(&self) -> Vec<String> {
        self.log
            .lock()
            .map(|guard| guard.iter().cloned().collect())
            .unwrap_or_default()
    }

    pub fn status(&self) -> PostizStatus {
        let docker_available = docker_available();
        let healthy = http_ok(HEALTH_PORT, "/");
        let state = if !docker_available {
            StackState::Unknown
        } else {
            match compose_ps_running() {
                Ok(true) => StackState::Running,
                Ok(false) => StackState::Stopped,
                // CLI present but daemon down (or old compose): unknown.
                Err(_) => StackState::Unknown,
            }
        };
        PostizStatus {
            docker_available,
            state,
            healthy,
            env_present: env_file().map(|f| f.is_file()).unwrap_or(false),
            last_log: self.snapshot_log(),
        }
    }

    pub fn start(&self) -> Result<PostizStatus, String> {
        if !docker_available() {
            return Err(
                "Docker was not found on PATH. Install Docker Desktop \
                 (https://www.docker.com/products/docker-desktop/), start it, \
                 then press Start again."
                    .into(),
            );
        }
        let compose = compose_file()?;
        let env = env_file()?;
        if !env.is_file() {
            return Err(format!(
                "{0} is missing. Copy {1} to {0}, set JWT_SECRET \
                 (and X_API_KEY / X_API_SECRET), then press Start again.",
                env.display(),
                env.with_file_name(".env.example").display()
            ));
        }

        self.push_log("[vera] docker compose up -d (first run pulls images — can take minutes)".into());
        let out = run_cmd(
            compose_command(
                &compose,
                Some(&env),
                &["up", "-d"],
            ),
            UP_TIMEOUT,
        )?;
        log_output(self, &out);
        if out.timed_out {
            return Err(format!(
                "docker compose up timed out after {}s — the image pull may still be \
                 running inside Docker; check Docker Desktop, then press Start again.",
                UP_TIMEOUT.as_secs()
            ));
        }
        if out.code != Some(0) {
            return Err(format!(
                "docker compose up failed (exit {:?}): {}",
                out.code,
                tail(&out.stderr, 800)
            ));
        }
        self.push_log("[vera] compose up finished".into());
        Ok(self.status())
    }

    /// `down` without `-v`: containers/networks go away, named volumes
    /// (Postgres data, Redis data, uploads, config) survive.
    pub fn stop(&self) -> Result<PostizStatus, String> {
        if !docker_available() {
            return Err(
                "Docker was not found on PATH — nothing to stop from here.".into(),
            );
        }
        let compose = compose_file()?;
        // Tolerate a missing .env on stop: substitution warnings are fine for
        // `down`, and the user may want the stack down before fixing .env.
        let env = env_file().ok().filter(|f| f.is_file());
        self.push_log("[vera] docker compose down".into());
        let out = run_cmd(compose_command(&compose, env.as_deref(), &["down"]), DOWN_TIMEOUT)?;
        log_output(self, &out);
        if out.timed_out {
            return Err(format!(
                "docker compose down timed out after {}s",
                DOWN_TIMEOUT.as_secs()
            ));
        }
        if out.code != Some(0) {
            return Err(format!(
                "docker compose down failed (exit {:?}): {}",
                out.code,
                tail(&out.stderr, 800)
            ));
        }
        self.push_log("[vera] compose down finished (volumes kept)".into());
        Ok(self.status())
    }
}

/* ---- paths ---- */

/// Candidate Postiz compose directories, in resolution order:
///
///   1. `VERA_POSTIZ_DIR` env override (absolute path).
///   2. `<dir of current exe>/postiz` — the packaged layout, where the
///      bundle resource mapping `{"../packaging/postiz": "postiz"}` installs
///      the compose stack next to the executable.
///   3. `<repo>/packaging/postiz` — dev fallback (CARGO_MANIFEST_DIR is
///      `src-tauri/`).
///
/// The first candidate containing `docker-compose.yml` wins.
fn postiz_dir_candidates() -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if let Ok(dir) = std::env::var("VERA_POSTIZ_DIR") {
        if !dir.trim().is_empty() {
            candidates.push(PathBuf::from(dir));
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(exe_dir) = exe.parent() {
            candidates.push(exe_dir.join("postiz"));
        }
    }
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    if let Some(repo) = manifest.parent() {
        candidates.push(repo.join("packaging").join("postiz"));
    }
    candidates
}

fn postiz_dir() -> Result<PathBuf, String> {
    let candidates = postiz_dir_candidates();
    for dir in &candidates {
        if dir.join("docker-compose.yml").is_file() {
            return Ok(dir.clone());
        }
    }
    Err(format!(
        "Postiz compose directory not found — no docker-compose.yml in any of: {}",
        candidates
            .iter()
            .map(|c| c.display().to_string())
            .collect::<Vec<_>>()
            .join(", ")
    ))
}

fn compose_file() -> Result<PathBuf, String> {
    Ok(postiz_dir()?.join("docker-compose.yml"))
}

fn env_file() -> Result<PathBuf, String> {
    Ok(postiz_dir()?.join(".env"))
}

/* ---- docker probes ---- */

fn docker_available() -> bool {
    run_cmd(simple_command("docker", &["--version"]), PROBE_TIMEOUT)
        .map(|out| out.code == Some(0))
        .unwrap_or(false)
}

/// True when at least one project container is running. Primary probe is
/// `ps --status running --quiet` (container ids only); older compose versions
/// without `--status` fall back to a substring scan of plain `ps` output.
fn compose_ps_running() -> Result<bool, String> {
    let compose = compose_file()?;
    let filtered = run_cmd(
        compose_command(&compose, None, &["ps", "--status", "running", "--quiet"]),
        PROBE_TIMEOUT,
    )?;
    if filtered.code == Some(0) {
        return Ok(filtered.stdout.lines().any(|l| !l.trim().is_empty()));
    }
    let plain = run_cmd(compose_command(&compose, None, &["ps"]), PROBE_TIMEOUT)?;
    if plain.code != Some(0) {
        return Err(tail(&plain.stderr, 400));
    }
    let text = plain.stdout.to_lowercase();
    Ok(text.contains("running") || text.contains("up "))
}

/* ---- process plumbing ---- */

struct CmdOut {
    code: Option<i32>,
    stdout: String,
    stderr: String,
    timed_out: bool,
}

fn simple_command(program: &str, args: &[&str]) -> Command {
    let mut cmd = Command::new(program);
    cmd.args(args);
    cmd
}

/// `docker compose [--env-file <env>] -f <compose> <args…>`. Absolute paths
/// everywhere, so the cwd of the Tauri process doesn't matter.
fn compose_command(compose: &std::path::Path, env: Option<&std::path::Path>, args: &[&str]) -> Command {
    let mut cmd = Command::new("docker");
    cmd.arg("compose");
    if let Some(env) = env {
        cmd.arg("--env-file").arg(env);
    }
    cmd.arg("-f").arg(compose);
    cmd.args(args);
    cmd
}

/// Spawn with piped streams (drained on reader threads so a chatty child
/// never blocks on a full pipe), poll to completion, kill on timeout.
fn run_cmd(mut cmd: Command, timeout: Duration) -> Result<CmdOut, String> {
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child: Child = cmd
        .spawn()
        .map_err(|e| format!("cannot spawn {:?}: {e}", cmd.get_program()))?;

    let mut stdout_pipe = child.stdout.take().expect("stdout piped");
    let mut stderr_pipe = child.stderr.take().expect("stderr piped");
    let out_handle = std::thread::spawn(move || {
        let mut s = String::new();
        let _ = stdout_pipe.read_to_string(&mut s);
        s
    });
    let err_handle = std::thread::spawn(move || {
        let mut s = String::new();
        let _ = stderr_pipe.read_to_string(&mut s);
        s
    });

    let deadline = Instant::now() + timeout;
    let mut timed_out = false;
    let code = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status.code(),
            Ok(None) => {
                if Instant::now() >= deadline {
                    timed_out = true;
                    let _ = child.kill();
                    let _ = child.wait();
                    break None;
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            Err(e) => return Err(format!("cannot wait on process: {e}")),
        }
    };

    let stdout = out_handle.join().unwrap_or_default();
    let stderr = err_handle.join().unwrap_or_default();
    Ok(CmdOut {
        code,
        stdout,
        stderr,
        timed_out,
    })
}

fn log_output(mgr: &PostizManager, out: &CmdOut) {
    for line in out.stdout.lines().chain(out.stderr.lines()).take(MAX_LOG_LINES) {
        if !line.trim().is_empty() {
            mgr.push_log(line.to_string());
        }
    }
}

fn tail(text: &str, max: usize) -> String {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return "(no output)".to_string();
    }
    trimmed
        .chars()
        .count()
        .checked_sub(max)
        .map(|skip| trimmed.chars().skip(skip).collect::<String>())
        .unwrap_or_else(|| trimmed.to_string())
}

/// HTTP GET against `127.0.0.1:{port}{path}`; true for any 2xx/3xx status.
/// Adapted from `sidecar::healthz_ok` — Postiz answers `/` with the Next.js
/// app (or a redirect), so unlike healthz we accept the whole 2xx/3xx range.
fn http_ok(port: u16, path: &str) -> bool {
    use std::io::Write;
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
    let Some(status_line) = text.lines().next() else {
        return false;
    };
    // "HTTP/1.1 200 OK" → 200
    let mut parts = status_line.split_whitespace();
    if !parts.next().map(|p| p.starts_with("HTTP/")).unwrap_or(false) {
        return false;
    }
    let Some(code) = parts.next().and_then(|c| c.parse::<u16>().ok()) else {
        return false;
    };
    (200..400).contains(&code)
}

/* ---- Tauri commands (blocking work on spawn_blocking, like vera_backend) ---- */

#[tauri::command]
pub async fn postiz_status(state: State<'_, Arc<PostizManager>>) -> Result<PostizStatus, String> {
    let mgr = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || mgr.status())
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn postiz_start(state: State<'_, Arc<PostizManager>>) -> Result<PostizStatus, String> {
    let mgr = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || mgr.start())
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn postiz_stop(state: State<'_, Arc<PostizManager>>) -> Result<PostizStatus, String> {
    let mgr = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || mgr.stop())
        .await
        .map_err(|e| e.to_string())?
}
