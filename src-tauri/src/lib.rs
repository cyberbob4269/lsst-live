// Vera Terminal — Tauri shell.
// Phase 1: plugins (opener, http) + F11 fullscreen toggle injected at runtime
// so the frontend stays portable. The sidecar module holds the generic
// spawn / healthz-poll / tree-kill helpers.
// Phase 2: IDE core — workspace-scoped fs commands (fs_cmds) and embedded
// PTY sessions (pty) for the file tree, editor, and terminal panes.
// Phase 3: AI core — provider API keys in the OS credential store
// (keyring_cmds) and non-interactive shell exec (shell) for the agent tools.
// Phase 4: Deep Space view — vera-home backend lifecycle (vera_backend):
// spawn/adopt the local dashboard backend on :8765 and kill only the
// self-spawned process tree on exit.
// Phase 5: Social suite — Postiz docker-compose lifecycle (postiz) plus
// binary fs commands for generated/upload media.

mod fs_cmds;
mod keyring_cmds;
mod postiz;
mod pty;
mod shell;
mod sidecar;
mod vera_backend;

use std::sync::Arc;

const F11_FULLSCREEN_TOGGLE: &str = r#"
(function () {
  if (window.__veraF11Bound) return;
  window.__veraF11Bound = true;
  window.addEventListener('keydown', async function (e) {
    if (e.key !== 'F11') return;
    e.preventDefault();
    try {
      // Tauri v2 global API (withGlobalTauri = true).
      var tauri = window.__TAURI__;
      if (!tauri || !tauri.window) return;
      var w = tauri.window.getCurrentWindow
        ? tauri.window.getCurrentWindow()
        : tauri.window.getCurrent();
      var current = await w.isFullscreen();
      await w.setFullscreen(!current);
    } catch (err) {
      console.error('[vera] fullscreen toggle failed', err);
    }
  });
})();
"#;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_http::init())
        .manage(Arc::new(pty::PtyManager::new()))
        .manage(Arc::new(vera_backend::VeraBackendManager::new()))
        .manage(Arc::new(postiz::PostizManager::new()))
        .invoke_handler(tauri::generate_handler![
            fs_cmds::fs_workspace_root,
            fs_cmds::fs_list_dir,
            fs_cmds::fs_read_file,
            fs_cmds::fs_write_file,
            fs_cmds::fs_ensure_dir,
            fs_cmds::fs_read_binary,
            fs_cmds::fs_write_binary,
            keyring_cmds::key_set,
            keyring_cmds::key_get,
            keyring_cmds::key_delete,
            keyring_cmds::key_status,
            shell::shell_exec,
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            vera_backend::vera_backend_start,
            vera_backend::vera_backend_stop,
            vera_backend::vera_backend_status,
            postiz::postiz_status,
            postiz::postiz_start,
            postiz::postiz_stop,
        ])
        .setup(|app| {
            use tauri::Manager;
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.eval(F11_FULLSCREEN_TOGGLE);
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| {
        // Kill any live PTY sessions so shells don't outlive the window, and
        // stop the vera-home backend — but only if WE spawned it (external
        // instances are adopted, never killed).
        if let tauri::RunEvent::Exit = event {
            use tauri::Manager;
            app_handle.state::<Arc<pty::PtyManager>>().kill_all();
            app_handle
                .state::<Arc<vera_backend::VeraBackendManager>>()
                .shutdown();
        }
    });
}
