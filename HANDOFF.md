# HANDOFF — Vera Terminal build state (2026-07-18, pre-reboot)

Read this first if you are the agent resuming after the reboot (or a context reset).
User: restart this session (`kimi resume`), then say "continue" — the goal is saved
(currently `blocked`, resume with `/goal resume` once the runtime checks below pass).

## Mission

Build "Vera Terminal" — standalone lightweight AI IDE/terminal (OpenClaw/Cursor-style)
at `C:/Users/Vera-at-home/projects/vera-terminal`. HARD RULE: never modify anything
under `C:/Users/Vera-at-home/projects/vera-home` (READ-ONLY forever).

## Status: v1 BUILT + shipped, polish round done, TTS done

All 6 phases complete (scaffold → IDE core → AI core → deep-space view → social suite → packaging).
Installer: `src-tauri/target/release/bundle/nsis/Vera Terminal_0.1.0_x64-setup.exe`
bundles: keyring fix + all 7 feedback items + xAI TTS. Rebuild installer ONLY at
milestones (`npm run tauri build -- --bundles nsis`); during changes use `npm run tauri dev`
(HMR for frontend; restart for Rust). Debug exe locks while the dev app runs — close it first if `cargo build` hits "Access is denied".

### Landed fixes worth remembering
- **keyring 3.x has NO default OS backend** — without `features = ["windows-native"]`
  it silently uses in-memory storage (save "works", reads find nothing). Fixed in
  `src-tauri/Cargo.toml` with a comment. Verified by user: Kimi key saves + Test passes.
- **kimi default model = `kimi-k3`** (user's Moonshot open-platform key, api.moonshot.ai).
- All 7 items from `workspace/builder-feedback.md` done: settings persist at
  `workspace/.vera/settings.json` (+ localStorage mirror), keep-alive views (CSS hide,
  polls gated on `visible`), chat history at `.vera/chat-history.json`, tool-output
  expanders, workspace-context injection on first message, diff-approve for writes,
  agent kill-switch in StatusBar. `.vera/` is gitignored.
- **xAI TTS**: `src/agent/tts.ts` — POST api.x.ai/v1/tts (Leo, mp3 44.1k/128k, 1800-char
  cap, contract ported from vera-home `src/xai_tts.py`). Speaker button per reply +
  "Speak replies" toggle. Uses xAI key from keyring.

## Where we are RIGHT NOW (reboot point)

- Docker Desktop installer was mid-flight and asked for a restart → user reboots now.
- vera-home data backup taken: `vera-home/data/backups/2026-07-18_1707` (their own
  `scripts/backup_vera_home.ps1`).
- vera-home backend (port 8765) was RUNNING at reboot — it is the user's own instance;
  after reboot they restart it their normal way (start-vera-home.bat / make serve).
  Deep Space view in the app can also start it (adopt-don't-duplicate built in).
- vera-terminal initial git commit made at this point (see `git log`).

## Environment quirks (cost us time — don't rediscover)

- **Two Windows profiles**: desktop user = `Vera-at-home` (owns the apps/keys);
  agent shell = `TSLA BoT`. Credential Manager vaults are per-user: `cmdkey /list`
  as TSLA BoT will NOT show the app's saved keys — that's expected, not a bug.
- venv shim: `vera-home/.venv/Scripts/python.exe` re-execs base Python311 → doubled
  processes; tree-kill from root PID works; soft taskkill never does (budget 5 s).
- `ps -W` col 4 is the WINPID (col 1 is cygwin pid — taskkill needs col 4).
- Read/Write/Edit tools refuse `.env*` paths — by design; don't route around it.
- vera-home `.venv` has BOTH bin/ (WSL) and Scripts/ (Windows) — created from both OSes.

## Remaining to close the goal (user-gated runtime checks)

1. **After reboot**: start Docker Desktop, wait for steady engine (whale icon).
2. App → **Social** → Re-check → wizard advances. `.env` step: see
   `packaging/postiz/POSTIZ_ENV_SETUP.txt` (pre-seeded JWT_SECRET; user adds
   X_API_KEY/X_API_SECRET from their X developer app — same creds vera-home uses).
3. Start Postiz (first `up -d` pulls images — minutes) → open localhost:4007 →
   create account → connect X channel (official OAuth) → copy Postiz API key →
   paste into Social wizard (stored in keyring as provider "postiz").
4. Draft flow test (goal criterion 4): compose + Grok Imagine image → "Send to
   Postiz as draft". Draft-only; never live-post without explicit user approval.
5. Provider Tests (criterion 2): kimi ✓ done; xAI — user said TTS works (key
   present); still click Test for the chat path; OpenAI + Anthropic keys still needed.
6. Criteria 1, 3, 5: already verified (build/IDE, deep-space smoke test healthz 200,
   vera-home untouched).

## House rules from the user

- No git mutations in vera-home; no commits anywhere without asking (vera-terminal
  initial commit was explicitly requested at backup time).
- vera-terminal git: local repo only, no remote configured.
- Draft-only social posting. Approve/deny gates on all write/shell agent tools.

## Addendum (2026-07-18 post-reboot)

- **Avast Web Shield MITM** broke all bundled-root HTTPS (curl + tauri-plugin-http).
  Fix: provider calls now go through `src-tauri/src/http_proxy.rs` (reqwest schannel/
  native-TLS, trusts Windows root store; host allowlist incl. api.x.ai/openai/
  anthropic/moonshot; `proxy_post`/`proxy_get`, base64 bodies). Live-tested 4xx
  in-band via cargo test. User also added the 4 API hosts to Avast exceptions.
- **Phase 7 (first-run)**: Welcome view wizard (providers→docker→postiz→backend→done,
  boots when setup incomplete, `welcome.dontShowOnBoot` in .vera/settings.json);
  `postiz_write_env` writes packaging/postiz/.env from the UI (overwrite-guarded);
  provider switch keeps conversation + ephemeral "now answering" notes.
- **Round 9A (nervous system)**: Signals tab — Grok Responses API
  (`POST {xaiBase}/responses`) with remote MCP tool `https://api.x.com/mcp`
  (server-side by xAI; NO direct api.x.com calls, NOT in allowlist). Files:
  `src/signals/*` (xintel.ts, sweepDefs.ts = vera-home's 5 topic bundles + watchlist,
  SignalsView.tsx, signalTools.ts). Agent tools `xintel_ask`/`xintel_sweep` (approval-
  gated, spend credit). Results persist to `.vera/signals.json`. UNTESTED live:
  needs user's xAI key; if MCP auth fails, add `authorization` to X_MCP_SERVER const.
- **Round 9B (UI ports)**: "Dashboards" tab with sub-tabs (TOI Lab | Dashboard |
  Screensaver) — iframes via extracted `src/deepspace/BackendFrame.tsx`; same backend
  lifecycle/adopt-don't-duplicate; shared autostart key; iframes never reload on
  tab switches.
- Postiz closeout STILL pending (user wizard steps: .env via "Set up Postiz for me",
  account, X channel, API key, draft test). Milestone NSIS rebuild + commit pending.
