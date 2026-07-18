//! Workspace-scoped filesystem commands for the IDE view (Phase 2).
//!
//! SCOPE GUARD: every incoming path is canonicalized and rejected when it
//! escapes the workspace root. The root is `VERA_TERMINAL_WORKSPACE` when set,
//! otherwise `<repo>/workspace` (next to `src-tauri/`). Violations return a
//! clear error string, never a panic.
//!
//! Paths returned to the frontend are normalized: the Windows `\\?\` verbatim
//! prefix is stripped and backslashes become forward slashes, so they are safe
//! to use as Monaco model paths. Incoming paths are re-canonicalized on every
//! call, so the normalized form round-trips fine.

use serde::Serialize;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

/// Editor loads are capped at 1 MB; larger files come back `truncated`.
const MAX_READ_BYTES: u64 = 1024 * 1024;

#[derive(Serialize)]
pub struct DirEntry {
    name: String,
    path: String,
    is_dir: bool,
    size: u64,
}

#[derive(Serialize)]
pub struct FileContent {
    content: String,
    truncated: bool,
}

pub(crate) fn workspace_root() -> Result<PathBuf, String> {
    let raw = match std::env::var("VERA_TERMINAL_WORKSPACE") {
        Ok(p) if !p.trim().is_empty() => PathBuf::from(p),
        _ => {
            // CARGO_MANIFEST_DIR is `src-tauri/`; the workspace sits next to it.
            let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
            manifest
                .parent()
                .map(|repo| repo.join("workspace"))
                .unwrap_or_else(|| manifest.join("workspace"))
        }
    };
    raw.canonicalize()
        .map_err(|e| format!("workspace root {} unavailable: {e}", raw.display()))
}

/// Canonicalize `path` (absolute, or relative to the workspace root) and
/// reject anything outside the root. Shared with `shell.rs` for cwd scoping.
pub(crate) fn resolve_in_workspace(path: &str) -> Result<PathBuf, String> {
    let root = workspace_root()?;
    let candidate = {
        let p = PathBuf::from(path);
        if p.is_absolute() {
            p
        } else {
            root.join(p)
        }
    };
    // The target itself may not exist yet (fs_write_file on a new file), so
    // fall back to canonicalizing the parent and re-appending the file name.
    let canonical = match candidate.canonicalize() {
        Ok(c) => c,
        Err(_) => {
            let parent = candidate
                .parent()
                .ok_or_else(|| "path has no parent".to_string())?;
            let parent = parent
                .canonicalize()
                .map_err(|e| format!("parent directory unavailable: {e}"))?;
            let name = candidate
                .file_name()
                .ok_or_else(|| "path has no file name".to_string())?;
            parent.join(name)
        }
    };
    if !canonical.starts_with(&root) {
        return Err(format!(
            "path escapes workspace root: {}",
            normalize(&canonical)
        ));
    }
    Ok(canonical)
}

/// Present a path without the Windows `\\?\` verbatim prefix, forward slashes.
pub(crate) fn normalize(p: &Path) -> String {
    let s = p.to_string_lossy().replace('\\', "/");
    match s.strip_prefix("//?/") {
        Some(stripped) => stripped.to_string(),
        None => s,
    }
}

#[tauri::command]
pub fn fs_workspace_root() -> Result<String, String> {
    workspace_root().map(|p| normalize(&p))
}

#[tauri::command]
pub fn fs_list_dir(path: String) -> Result<Vec<DirEntry>, String> {
    let dir = resolve_in_workspace(&path)?;
    let read =
        fs::read_dir(&dir).map_err(|e| format!("cannot list {}: {e}", normalize(&dir)))?;
    let mut entries = Vec::new();
    for entry in read {
        let entry = entry.map_err(|e| e.to_string())?;
        let meta = entry.metadata().map_err(|e| e.to_string())?;
        entries.push(DirEntry {
            name: entry.file_name().to_string_lossy().to_string(),
            path: normalize(&entry.path()),
            is_dir: meta.is_dir(),
            size: if meta.is_dir() { 0 } else { meta.len() },
        });
    }
    // Dirs first, then case-insensitive name order.
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(entries)
}

#[tauri::command]
pub fn fs_read_file(path: String) -> Result<FileContent, String> {
    let file = resolve_in_workspace(&path)?;
    let meta =
        fs::metadata(&file).map_err(|e| format!("cannot stat {}: {e}", normalize(&file)))?;
    if meta.is_dir() {
        return Err(format!("{} is a directory", normalize(&file)));
    }
    let truncated = meta.len() > MAX_READ_BYTES;
    let handle =
        fs::File::open(&file).map_err(|e| format!("cannot open {}: {e}", normalize(&file)))?;
    let mut buf = Vec::new();
    handle
        .take(MAX_READ_BYTES)
        .read_to_end(&mut buf)
        .map_err(|e| format!("cannot read {}: {e}", normalize(&file)))?;
    Ok(FileContent {
        content: String::from_utf8_lossy(&buf).to_string(),
        truncated,
    })
}

#[tauri::command]
pub fn fs_write_file(path: String, content: String) -> Result<(), String> {
    let file = resolve_in_workspace(&path)?;
    if file.is_dir() {
        return Err(format!("{} is a directory", normalize(&file)));
    }
    fs::write(&file, content).map_err(|e| format!("cannot write {}: {e}", normalize(&file)))
}

/// Create a directory (and any missing parents) inside the workspace. Used
/// by the frontend to provision `.vera/` before writing settings/history.
#[tauri::command]
pub fn fs_ensure_dir(path: String) -> Result<(), String> {
    let dir = resolve_in_workspace(&path)?;
    if dir.is_file() {
        return Err(format!("{} is a file", normalize(&dir)));
    }
    fs::create_dir_all(&dir).map_err(|e| format!("cannot create {}: {e}", normalize(&dir)))
}

/// Largest binary payload accepted/produced by the two commands below
/// (generated videos and upload media) — 128 MB.
const MAX_BINARY_BYTES: usize = 128 * 1024 * 1024;

/// Binary counterpart of `fs_read_file` for media files (Phase 5): returns
/// the file base64-encoded so the frontend can build Blobs / upload bodies.
#[tauri::command]
pub fn fs_read_binary(path: String) -> Result<String, String> {
    use base64::Engine;
    let file = resolve_in_workspace(&path)?;
    let meta =
        fs::metadata(&file).map_err(|e| format!("cannot stat {}: {e}", normalize(&file)))?;
    if meta.is_dir() {
        return Err(format!("{} is a directory", normalize(&file)));
    }
    if meta.len() > MAX_BINARY_BYTES as u64 {
        return Err(format!(
            "{} exceeds the 128 MB binary-read limit",
            normalize(&file)
        ));
    }
    let bytes = fs::read(&file).map_err(|e| format!("cannot read {}: {e}", normalize(&file)))?;
    Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
}

/// Binary counterpart of `fs_write_file` (Phase 5): decodes base64 and writes
/// the bytes, creating parent directories as needed (social-media/ may not
/// exist yet). Same workspace scope guard as every other fs command.
#[tauri::command]
pub fn fs_write_binary(path: String, base64: String) -> Result<(), String> {
    use base64::Engine;
    let file = resolve_in_workspace(&path)?;
    if file.is_dir() {
        return Err(format!("{} is a directory", normalize(&file)));
    }
    // Reject oversized payloads before decoding (base64 inflates by ~4/3).
    if base64.len() > MAX_BINARY_BYTES * 4 / 3 + 4 {
        return Err("payload exceeds the 128 MB binary-write limit".to_string());
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(&base64)
        .map_err(|e| format!("invalid base64 payload: {e}"))?;
    if let Some(parent) = file.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("cannot create {}: {e}", normalize(parent)))?;
    }
    fs::write(&file, bytes).map_err(|e| format!("cannot write {}: {e}", normalize(&file)))
}
