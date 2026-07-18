# Vera Terminal

A standalone, lightweight AI IDE / terminal desktop app for the Vera@Home
projects — OpenClaw/Cursor-style, built with Tauri 2 + Vite + React +
TypeScript. Dark space theme.

## Feature tour

- **IDE** — Monaco editor with syntax highlighting, a workspace file tree,
  and an embedded xterm.js terminal backed by a real PTY (PowerShell/cmd).
  File access is scoped to the chosen workspace root.
- **AI chat** — talk to xAI (Grok), OpenAI, Anthropic, or Kimi/Moonshot.
  The agent loop exposes deep tools (workspace fs, shell exec) gated by an
  approve/deny prompt per call, plus draft-only social tools.
- **Deep Space** — embeds the live vera-home dashboard (`localhost:8765`) in
  an iframe and manages the backend lifecycle: it starts the vera-home
  backend if it isn't running (expects the repo at
  `C:\Users\Vera-at-home\projects\vera-home`), adopts an already-running
  instance, and only ever kills the process it spawned itself.
- **Social** — a vendored Postiz docker stack (compose project `vera-postiz`,
  app on `localhost:4007`), Grok Imagine media generation, and draft-only
  posting: nothing is ever published directly from Vera Terminal.
- **Settings** — provider API keys are stored in the Windows Credential
  Manager (OS keyring), never on disk, with a Test button per provider.

## Prerequisites

- Windows 10/11 with WebView2 (preinstalled on current Windows).
- **Dev only:** Rust stable (rustup) + Node.js 18+.
- **Social/Postiz only:** Docker Desktop running.

## First-run setup

1. **Settings** — paste your provider API keys (xAI / OpenAI / Anthropic /
   Kimi). They go into the Windows Credential Manager. Press *Test* on each.
2. **Social** — install and start Docker Desktop. In the Postiz directory
   (`packaging/postiz/` in the repo, or `postiz/` next to the installed exe;
   override with the `VERA_POSTIZ_DIR` env var):
   copy `.env.example` to `.env`, set `JWT_SECRET` (any long random string)
   and `X_API_KEY` / `X_API_SECRET` (from your X developer app). Press
   *Start Postiz* (first run pulls images — takes minutes), open
   <http://localhost:4007>, create the Postiz account, connect the X
   channel, generate a Postiz API key, and paste it into Vera Terminal.
3. **Deep Space** — auto-starts the vera-home backend on first use; expects
   vera-home at `C:\Users\Vera-at-home\projects\vera-home`.

## Development

```bash
npm install
npm run tauri dev        # frontend dev server + Tauri shell
npm run build            # type-check + vite build → dist/
cargo build              # Rust only (in src-tauri/)
npm run tauri build -- --bundles nsis   # release build + NSIS installer
```

Artifacts land in `src-tauri/target/release/` (`vera-terminal.exe` and
`bundle/nsis/Vera Terminal_0.1.0_x64-setup.exe`).

> **Packaging note:** the bundler copies the whole `packaging/postiz/`
> directory into the installer. Make sure your real `packaging/postiz/.env`
> (with secrets) does NOT exist when building the installer — only
> `.env.example` should ship.

## Safety model

- File and shell tools are scoped to the workspace root you picked.
- Every agent tool call requires an explicit approve/deny click.
- Social posting is draft-only — publishing happens in Postiz, by you.
- API keys live in the OS credential store, never in files.

## Notes

- The installer is **unsigned**: Windows SmartScreen will warn on first
  launch ("Windows protected your PC") — click *More info → Run anyway*.
  This is expected for an unsigned binary.
- `csp: null` is set in `tauri.conf.json` — this is a local tool that embeds
  localhost dashboards and provider endpoints; acceptable for this use case,
  worth revisiting if remote content is ever loaded.
