# LSST Live

A standalone Windows desktop app for deep-space dashboards and labs, with an
optional AI IDE and optional social tools. Built with Tauri 2 + Vite + React +
TypeScript. Published by **Netwrx Solutions Limited** (Skunk Foundry software).

**Not affiliated with NSF or the Vera C. Rubin Observatory.**

Public site: [lsst-live-site](https://cyberbob4269.github.io/lsst-live-site/)

## Features

- **Dashboards** — TRAPPIST-1, TOI neighborhood, comet, asteroid, Taurid stream,
  orbital sky labs, ops dashboard, and screensaver. Uses public hosted labs by
  default; optional local vera-home backend on `127.0.0.1:8765` when configured.
- **Deep Space** — deep-space hub (`/ui/deep-space/index.html`).
- **IDE** — Monaco editor, workspace file tree, embedded xterm.js terminal, and
  optional AI chat (xAI, OpenAI, Anthropic, Kimi).
- **Social** (optional) — Postiz docker stack for draft-only social posting.
  Requires Docker Desktop; not needed for dashboards or labs.
- **Settings** — provider API keys in the Windows Credential Manager; configurable
  vera-home backend path.

## Public labs (no setup)

Without a local backend, Dashboards embed the public hosted labs:

- [All labs](https://cyberbob4269.github.io/lsst-live-site/labs/)
- [TRAPPIST-1](https://cyberbob4269.github.io/lsst-live-site/labs/trappist-1-lab.html)
- [TOI neighborhood](https://cyberbob4269.github.io/lsst-live-site/labs/toi-neighborhood-lab.html)

## Prerequisites

- Windows 10/11 with WebView2 (preinstalled on current Windows).
- **Dev only:** Rust stable (rustup) + Node.js 18+.
- **Local backend (optional):** a vera-home checkout with Python dependencies.
- **Social/Postiz (optional):** Docker Desktop.

## First run

1. Open **Dashboards** — public labs work immediately with no Docker, Postiz, or
   local backend.
2. **Optional:** Settings → set **vera-home path** and start the local backend
   for full local labs and the ops dashboard.
3. **Optional:** Settings → add AI provider keys for chat and agent tools.
4. **Optional:** Welcome or Social tab → Docker + Postiz for draft social posting.

## Development

```bash
npm install
npm run tauri dev        # frontend dev server + Tauri shell
npm run build            # type-check + vite build → dist/
cargo build              # Rust only (in src-tauri/)
npm run tauri build -- --bundles nsis   # release build + NSIS installer
```

Release artifacts land in `src-tauri/target/release/` (`lsst-live.exe` or the
bundled binary name) and `bundle/nsis/LSST Live_0.1.0_x64-setup.exe`.

> **Packaging note:** the bundler copies `packaging/postiz/` into the installer.
> Do not ship a real `.env` with secrets — only `.env.example` should be present
> at build time.

## Safety model

- File and shell tools are scoped to the workspace root you picked.
- Every agent tool call requires an explicit approve/deny click.
- Social posting is draft-only — publishing happens in Postiz, by you.
- API keys live in the OS credential store, never in files.

## Notes

- The installer is **unsigned**: Windows SmartScreen may warn on first launch.
  Click *More info → Run anyway*. Expected for an unsigned binary.
- `csp: null` in `tauri.conf.json` — local tool embedding localhost dashboards
  and provider endpoints.
