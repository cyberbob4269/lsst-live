Vera Terminal — v1 "Mini-IDE" Build Plan                                                             │ 

&#x20;  │                                                                                                      │ 

&#x20;  │ Mission (as set by user)                                                                             │ 

&#x20;  │                                                                                                      │ 

&#x20;  │ A clean, standalone lightweight AI IDE/terminal (OpenClaw/Cursor-style) for the Vera@Home projects:  │ 

&#x20;  │ one unified interface with AI control, embedded deep-space dashboard, a newly imported               │ 

&#x20;  │ social-posting engine (replacing the clunky in-house sprawl, keeping Grok Imagine for media), and    │ 

&#x20;  │ model providers configurable via API keys (xAI/Grok, OpenAI, Anthropic, Kimi/Moonshot). Zero         │ 

&#x20;  │ modifications to existing vera-home files.                                                           │ 

&#x20;  │                                                                                                      │ 

&#x20;  │ Key decisions (locked by user)                                                                       │ 

&#x20;  │                                                                                                      │ 

&#x20;  │ • Base: reuse the proven Tauri 2.x foundation from vera-home/tauri/, copied — not modified.          │ 

&#x20;  │ • v1 scope: Mini-IDE — file tree, code editor, embedded terminal, deep-space view, AI chat with deep │ 

&#x20;  │   tools, social suite, settings.                                                                     │ 

&#x20;  │ • AI control: deep tools from day one (fs read/write, shell, git) inside the standalone workspace.   │ 

&#x20;  │ • Social: import an open-source engine rather than rebuild; Grok Imagine stays as media generator.   │ 

&#x20;  │                                                                                                      │ 

&#x20;  │ Location                                                                                             │ 

&#x20;  │                                                                                                      │ 

&#x20;  │ New sibling project: C:/Users/Vera-at-home/projects/vera-terminal — its own git repo, outside the    │ 

&#x20;  │ vera-home working tree. (Needs your OK since it sits next to, not inside, vera-home.)                │ 

&#x20;  │                                                                                                      │ 

&#x20;  │ What we import from vera-home (copies or read-only runtime use — originals untouched)                │ 

&#x20;  │                                                                                                      │ 

&#x20;  │ ┌──────────────────────────────────────┬───────────────────────────────────────────────────────────┐ │ 

&#x20;  │ │ Asset                                │ How used                                                  │ │ 

&#x20;  │ ├──────────────────────────────────────┼───────────────────────────────────────────────────────────┤ │ 

&#x20;  │ │ tauri/src-tauri/src/lib.rs sidecar   │ Copied + adapted: spawn backend, poll /healthz, navigate  │ │ 

&#x20;  │ │ pattern                              │ webview, graceful process-tree kill                       │ │ 

&#x20;  │ ├──────────────────────────────────────┼───────────────────────────────────────────────────────────┤ │ 

&#x20;  │ │ scripts/run\_vera\_home.py /           │ Spawned read-only as the live data backend on             │ │ 

&#x20;  │ │ launch\_backend.py                    │ 127.0.0.1:8765 (runtime writes go to vera-home/data/      │ │ 

&#x20;  │ │                                      │ exactly as they do today — no source edits)               │ │ 

&#x20;  │ ├──────────────────────────────────────┼───────────────────────────────────────────────────────────┤ │ 

&#x20;  │ │ ui/deep-space/                       │ Embedded via iframe pointed at                            │ │ 

&#x20;  │ │                                      │ http://127.0.0.1:8765/ui/deep-space/index.html (it is     │ │ 

&#x20;  │ │                                      │ same-origin coupled to :8765; server sends no framing     │ │ 

&#x20;  │ │                                      │ blocks, API CORS is \*)                                    │ │ 

&#x20;  │ ├──────────────────────────────────────┼───────────────────────────────────────────────────────────┤ │ 

&#x20;  │ │ scripts/social/xai\_imagine.py logic  │ Ported to TypeScript: Grok Imagine image+video via        │ │ 

&#x20;  │ │                                      │ `api.x.ai/v1/images                                       │ │ 

&#x20;  │ ├──────────────────────────────────────┼───────────────────────────────────────────────────────────┤ │ 

&#x20;  │ │ data/social/ media catalogs (NASA    │ Read-only media library for post content                  │ │ 

&#x20;  │ │ imagery, xai-imagine)                │                                                           │ │ 

&#x20;  │ ├──────────────────────────────────────┼───────────────────────────────────────────────────────────┤ │ 

&#x20;  │ │ scripts/package\_windows.ps1 +        │ Adapted for Vera Terminal's own NSIS installer            │ │ 

&#x20;  │ │ build\_backend\_sidecar.py pattern     │                                                           │ │ 

&#x20;  │ ├──────────────────────────────────────┼───────────────────────────────────────────────────────────┤ │ 

&#x20;  │ │ Old scripts/social/\* posting         │ Frozen, not imported. X auth is re-done through the new   │ │ 

&#x20;  │ │ machinery                            │ engine's official OAuth                                   │ │ 

&#x20;  │ └──────────────────────────────────────┴───────────────────────────────────────────────────────────┘ │ 

&#x20;  │                                                                                                      │ 

&#x20;  │ Architecture                                                                                         │ 

&#x20;  │                                                                                                      │ 

&#x20;  │ ```                                                                                                  │ 

&#x20;  │   vera-terminal/                       (new git repo)                                                │ 

&#x20;  │   ├─ src-tauri/        Tauri 2.x Rust shell                                                          │ 

&#x20;  │   │   ├─ lib.rs        window, sidecar mgmt (vera backend + social engine)                           │ 

&#x20;  │   │   ├─ pty.rs        portable-pty → embedded terminal                                              │ 

&#x20;  │   │   ├─ fs\_cmds.rs    deep tools: read/write/list/search (workspace-scoped)                         │ 

&#x20;  │   │   ├─ git\_cmds.rs   git status/diff/commit via git2 or shell                                      │ 

&#x20;  │   │   └─ keyring.rs    API keys in Windows Credential Manager (keyring crate)                        │ 

&#x20;  │   ├─ src/              Frontend (Vite + React + TypeScript)                                          │ 

&#x20;  │   │   ├─ ide/          file tree, Monaco editor tabs, xterm.js terminal                              │ 

&#x20;  │   │   ├─ agent/        AI core: provider abstraction + tool loop                                     │ 

&#x20;  │   │   │   ├─ providers/ openai-compatible client (xAI, OpenAI, Kimi/Moonshot)                        │ 

&#x20;  │   │   │   │           + anthropic adapter (Messages API)                                             │ 

&#x20;  │   │   │   └─ tools/    fs, shell, git, vera-api, social — permission-gated                           │ 

&#x20;  │   │   ├─ dashboard/    deep-space iframe view + service start/stop controls                          │ 

&#x20;  │   │   ├─ social/       posting UI: queue, channels, media picker, compose                            │ 

&#x20;  │   │   └─ settings/     provider keys + test-call buttons, model picker                               │ 

&#x20;  │   └─ packaging/        NSIS installer pipeline (adapted from vera-home)                              │ 

&#x20;  │ ```                                                                                                  │ 

&#x20;  │                                                                                                      │ 

&#x20;  │ • Webview ↔ providers: tauri-plugin-http (native HTTP, bypasses CORS). xAI, OpenAI, Kimi/Moonshot    │ 

&#x20;  │   are all OpenAI-compatible → one client; Anthropic gets a thin adapter.                             │ 

&#x20;  │ • Agent loop runs in TypeScript; deep tools bridge to Rust commands. Every tool call is shown in the │ 

&#x20;  │   chat with approve/deny (deep tools, but gated).                                                    │ 

&#x20;  │ • Keys never written to disk in plaintext — OS keyring via small Rust commands.                      │ 

&#x20;  │                                                                                                      │ 

&#x20;  │ Social engine (the fork — see options at approval)                                                   │ 

&#x20;  │                                                                                                      │ 

&#x20;  │ Option A (recommended): Postiz self-hosted — gitroomhq/postiz-app, AGPL-3.0, very active, official   │ 

&#x20;  │ OAuth flows (X, Bluesky, Mastodon, Discord, YouTube, more). Why it fits: public API + NodeJS SDK,    │ 

&#x20;  │ and it ships a Postiz agent CLI built explicitly for agentic control ("perfect for OpenClaw and      │ 

&#x20;  │ other agents") — exactly our use case. Runs via Docker Compose (Postgres + Temporal + app). Vera     │ 

&#x20;  │ Terminal talks to it over its API; the AI's social skills = compose\_post, generate\_media (Grok       │ 

&#x20;  │ Imagine), upload\_media, schedule\_post, post\_now, list\_channels, analytics. Requires Docker Desktop   │ 

&#x20;  │ (or Docker in WSL2). AGPL is fine for self-hosted personal use.                                      │ 

&#x20;  │                                                                                                      │ 

&#x20;  │ Option B: lightweight in-house poster — no Docker; a small clean TypeScript module posting to X API  │ 

&#x20;  │ v2 directly (OAuth2 PKCE), plus a simple local queue/scheduler in the app, reusing Grok Imagine +    │ 

&#x20;  │ media catalogs. Lighter install, but we own maintenance — the same path that produced the current    │ 

&#x20;  │ clunky sprawl, so it needs strict discipline (one module, tests).                                    │ 

&#x20;  │                                                                                                      │ 

&#x20;  │ Phases \& verification                                                                                │ 

&#x20;  │                                                                                                      │ 

&#x20;  │ 1. Scaffold — create vera-terminal repo, Tauri 2 skeleton, layout shell (sidebar/editor/chat/dock),  │ 

&#x20;  │    window config. Verify: app launches, cargo build + vite build clean.                              │ 

&#x20;  │ 2. IDE core — file tree + Monaco tabs + fs commands; xterm.js + portable-pty terminal. Verify: edit  │ 

&#x20;  │    \& save a file in a sandbox workspace; run echo in embedded terminal.                              │ 

&#x20;  │ 3. AI core — provider abstraction, keyring settings page, test call per provider; chat panel with    │ 

&#x20;  │    tool loop (fs/shell/git, workspace-scoped, approve/deny UI). Verify: a chat turn that reads a     │ 

&#x20;  │    file and writes a new one via tools, with each configured provider passing its test call.         │ 

&#x20;  │ 4. Deep-space view — spawn vera-home backend sidecar, healthz poll, iframe view + start/stop/restart │ 

&#x20;  │    controls + status chip. Verify: dashboard loads live data; backend shuts down cleanly with app.   │ 

&#x20;  │ 5. Social suite — (A) Postiz compose stack + connect X via official OAuth, or (B) poster module + X  │ 

&#x20;  │    OAuth2 PKCE; Grok Imagine media skill; queue view. Verify: AI composes a post with a Grok Imagine │ 

&#x20;  │    image and lands it as a draft/scheduled post (no live posting without your explicit approval).    │ 

&#x20;  │ 6. Package \& docs — NSIS installer, README, settings backup note. Verify: installer runs on the      │ 

&#x20;  │    machine, app starts standalone.                                                                   │ 

&#x20;  │                                                                                                      │ 

&#x20;  │ Safety rails                                                                                         │ 

&#x20;  │                                                                                                      │ 

&#x20;  │ • No writes outside the workspace except: vera-home backend runtime data (its normal behavior) and   │ 

&#x20;  │   the OS keyring.                                                                                    │ 

&#x20;  │ • Social posting defaults to draft/schedule; live posting always requires explicit user confirmation │ 

&#x20;  │   in the UI.                                                                                         │ 

&#x20;  │ • Tool execution (shell/write) shows exact command/diff before running.                              │ 

&#x20;  │                                                                                                      │ 

&#x20;  │ Risks / notes                                                                                        │ 

&#x20;  │                                                                                                      │ 

&#x20;  │ • Docker is a new prerequisite for Option A.                                                         │ 

&#x20;  │ • Running the vera backend from vera-home writes to vera-home/data/ (its normal churn) — source      │ 

&#x20;  │   files stay untouched.                                                                              │ 

&#x20;  │ • X API access costs/limits are unchanged; Postiz uses your own X app credentials via official       │ 

&#x20;  │   OAuth.                                                                                             │ 

&#x20;  │                                                                                                      │ 

&#x20;  │ Out of scope (v1)                                                                                    │ 

&#x20;  │                                                                                                      │ 

&#x20;  │ • Multi-agent orchestration, voice/TTS, screensaver/tauri v1 migration, repo-hygiene cleanup from    │ 

&#x20;  │   earlier review, YouTube/TikTok posting (Postiz supports them later via channel add).  

