// Social view (Phase 5). A setup wizard driven by postiz_status (polled
// every 5 s while the view is visible), then a three-pane workbench:
//
//   A "no-docker"  — Docker CLI absent: install instructions + Re-check.
//   B "stopped"    — Docker present, stack down: Start Postiz. A missing
//                    .env gets a friendly one-liner + a jump to the Welcome
//                    setup (Phase 7), with the manual steps kept in a
//                    collapsed "Advanced" details for power users.
//   C "need-key"   — stack healthy, no Postiz API key in the keyring:
//                    account/channel/API-key walkthrough + paste field.
//   D "workbench"  — Compose (textarea + char count + AI draft + media
//                    picker + Grok Imagine), Queue (channels + recent
//                    posts/drafts), Send (approval-gated draft creation).
//
// The Send flow NEVER posts live: postizClient.createDraft hard-codes
// type "draft".

import { useCallback, useEffect, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { chatCompletion, loadProviderConfigs } from "../agent/providers";
import { keyDelete, keyGet, keySet } from "../agent/ipc";
import { fsListDir, fsReadBinary } from "../ide/ipc";
import { postizStart, postizStatus, postizStop, type PostizStatus } from "./ipc";
import { generateImage } from "./grokImagine";
import { base64ToBytes } from "./binary";
import {
  DEFAULT_POSTIZ_BASE_URL,
  createDraft,
  getPostizBaseUrl,
  listChannels,
  listRecentPosts,
  setPostizBaseUrl,
  type PostizChannel,
  type PostizPost,
} from "./postizClient";

const POSTIZ_UI_URL = "http://localhost:4007";
const DOCKER_DESKTOP_URL = "https://www.docker.com/products/docker-desktop/";
const POLL_MS = 5000;
const X_CHAR_LIMIT = 280;
const MEDIA_DIR = "social-media";
const MEDIA_EXT = /\.(png|jpe?g|gif|webp|mp4)$/i;
const IMAGE_EXT = /\.(png|jpe?g|gif|webp)$/i;

type UiState = "loading" | "no-docker" | "stopped" | "need-key" | "workbench";

function deriveState(status: PostizStatus | null, hasKey: boolean): UiState {
  if (!status) return "loading";
  if (!status.dockerAvailable) return "no-docker";
  if (!(status.state === "running" && status.healthy)) return "stopped";
  if (!hasKey) return "need-key";
  return "workbench";
}

export default function SocialView({
  visible,
  onOpenWelcome,
}: {
  visible: boolean;
  /** Phase 7: jump to the Welcome setup concierge (writes the Postiz .env). */
  onOpenWelcome: () => void;
}) {
  const [status, setStatus] = useState<PostizStatus | null>(null);
  const [hasKey, setHasKey] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmRemoveKey, setConfirmRemoveKey] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const s = await postizStatus();
      setStatus(s);
      setError(null);
    } catch (err) {
      setError(String(err));
    }
    try {
      setHasKey(!!(await keyGet("postiz")));
    } catch (err) {
      console.error("[vera] key_get(postiz) failed", err);
    }
  }, []);

  // Poll while visible to drive the wizard state machine. The view stays
  // mounted when hidden (keep-alive in App.tsx), so the interval must be
  // torn down then; it re-fires immediately on becoming visible again.
  useEffect(() => {
    if (!visible) return;
    void refresh();
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [refresh, visible]);

  const doStart = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      setStatus(await postizStart());
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }, []);

  const doStop = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      setStatus(await postizStop());
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }, []);

  // Delete the saved Postiz API key so the user can re-enter it — the view
  // drops back to the "need-key" onboarding card automatically (deriveState).
  const doRemoveKey = useCallback(async () => {
    try {
      await keyDelete("postiz");
    } catch (err) {
      console.error("[vera] key_delete(postiz) failed", err);
    }
    setHasKey(false);
  }, []);

  const uiState = deriveState(status, hasKey);

  const chipClass =
    uiState === "workbench" ? "is-live" : uiState === "stopped" || uiState === "need-key" ? "is-starting" : "is-error";
  const chipText =
    uiState === "loading"
      ? "Checking…"
      : uiState === "no-docker"
        ? "Docker missing"
        : uiState === "stopped"
          ? status?.state === "running"
            ? "Postiz starting…"
            : "Postiz stopped"
          : uiState === "need-key"
            ? "API key needed"
            : "Connected";

  return (
    <div className="soc-wrap">
      <header className="ds-toolbar">
        <span className={`ds-chip ${chipClass}`}>{chipText}</span>
        <div className="ds-actions">
          {uiState === "stopped" && (
            <button className="settings-btn" disabled={busy} onClick={() => void doStart()}>
              {busy ? "Starting…" : "Start Postiz"}
            </button>
          )}
          {status?.state === "running" && (
            <button className="settings-btn is-danger" disabled={busy} onClick={() => void doStop()}>
              Stop Postiz
            </button>
          )}
          {hasKey && (
            <button
              className={`settings-btn${confirmRemoveKey ? " is-danger" : ""}`}
              title="Delete the saved Postiz API key so you can enter a new one"
              onClick={() => {
                if (!confirmRemoveKey) {
                  setConfirmRemoveKey(true);
                  return;
                }
                setConfirmRemoveKey(false);
                void doRemoveKey();
              }}
            >
              {confirmRemoveKey ? "Confirm remove key" : "Change API key"}
            </button>
          )}
        </div>
        <span className="ds-path muted" title={getPostizBaseUrl()}>
          {POSTIZ_UI_URL}
        </span>
      </header>

      {error && (
        <div className="soc-errorbar" role="alert">
          {error}
        </div>
      )}

      {uiState === "loading" && (
        <div className="pane-body muted">Checking Docker and the Postiz stack…</div>
      )}

      {uiState === "no-docker" && (
        <div className="soc-center">
          <section className="settings-card soc-card">
            <h2 className="settings-card-title">Docker Desktop required</h2>
            <p className="muted soc-p">
              The Postiz stack runs in Docker containers (app, Postgres, Redis,
              Temporal), but no <code>docker</code> command was found on this
              machine.
            </p>
            <ol className="muted soc-steps">
              <li>Install Docker Desktop (free for personal use).</li>
              <li>Start Docker Desktop and wait for the engine to come up.</li>
              <li>Come back here and press Re-check.</li>
            </ol>
            <div className="ds-actions">
              <button className="settings-btn" onClick={() => void openUrl(DOCKER_DESKTOP_URL)}>
                Get Docker Desktop
              </button>
              <button className="settings-btn" onClick={() => void refresh()}>
                Re-check
              </button>
            </div>
          </section>
        </div>
      )}

      {uiState === "stopped" && status && (
        <div className="soc-center">
          <section className="settings-card soc-card">
            <h2 className="settings-card-title">Postiz stack is not running</h2>
            {!status.envPresent && (
              <div className="soc-warning">
                <p className="soc-warning-title">Postiz needs a one-time config file</p>
                <p className="muted soc-p">
                  Nothing is wrong — Postiz just hasn't been configured yet. The Welcome
                  setup writes the file for you in one click (a fresh random secret
                  included), then starts the stack.
                </p>
                <div className="ds-actions">
                  <button className="settings-btn" onClick={onOpenWelcome}>
                    Open the Welcome setup
                  </button>
                </div>
                <details className="soc-advanced">
                  <summary>Advanced: manual .env steps</summary>
                  <ol className="muted soc-steps">
                    <li>
                      Copy <code>.env.example</code> to <code>.env</code> in the Postiz directory
                      (<code>packaging/postiz/</code> in dev, <code>postiz/</code> next to the
                      installed app)
                    </li>
                    <li>
                      Set <code>JWT_SECRET</code> to a long random string
                    </li>
                    <li>
                      Add <code>X_API_KEY</code> / <code>X_API_SECRET</code> (your X developer app
                      credentials)
                    </li>
                  </ol>
                </details>
              </div>
            )}
            <p className="muted soc-p">
              {status.state === "running"
                ? "Containers are up — waiting for Postiz to answer on localhost:4007 (first boot runs migrations, give it a minute)."
                : "Press Start Postiz to bring the stack up. The first run pulls images and can take several minutes."}
            </p>
            <div className="ds-actions">
              <button className="settings-btn" disabled={busy || !status.envPresent} onClick={() => void doStart()}>
                {busy ? "Starting…" : "Start Postiz"}
              </button>
              <button className="settings-btn" onClick={() => void refresh()}>
                Re-check
              </button>
            </div>
            {status.lastLog.length > 0 && (
              <pre className="ds-log soc-log">{status.lastLog.join("\n")}</pre>
            )}
          </section>
        </div>
      )}

      {uiState === "need-key" && (
        <ApiKeyCard
          onSaved={() => {
            setHasKey(true);
            void refresh();
          }}
        />
      )}

      {uiState === "workbench" && <Workbench />}
    </div>
  );
}

/* ---- State C: API key onboarding ---- */

function ApiKeyCard({ onSaved }: { onSaved: () => void }) {
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [baseUrl, setBaseUrl] = useState(getPostizBaseUrl);

  const save = useCallback(async () => {
    const value = input.trim();
    if (!value) return;
    try {
      await keySet("postiz", value);
      setPostizBaseUrl(baseUrl);
      setInput("");
      onSaved();
    } catch (err) {
      setError(String(err));
    }
  }, [input, baseUrl, onSaved]);

  return (
    <div className="soc-center">
      <section className="settings-card soc-card">
        <h2 className="settings-card-title">Connect Vera to Postiz</h2>
        <ol className="muted soc-steps">
          <li>
            Open Postiz at <code>http://localhost:4007</code> and create your account.
          </li>
          <li>Connect your X channel (Channels → add channel).</li>
          <li>
            In Postiz Settings, create an API key and copy it (public API access).
          </li>
          <li>Paste the key below — it goes to the OS credential store, never to disk.</li>
        </ol>
        <div className="ds-actions">
          <button className="settings-btn" onClick={() => void openUrl(POSTIZ_UI_URL)}>
            Open Postiz
          </button>
        </div>
        <label className="settings-field">
          <span className="settings-label">Postiz API key</span>
          <div className="settings-key-row">
            <input
              type="password"
              className="settings-input"
              placeholder="Paste Postiz API key…"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
            <button className="settings-btn" disabled={!input.trim()} onClick={() => void save()}>
              Save
            </button>
          </div>
        </label>
        <label className="settings-field">
          <span className="settings-label">Postiz API base URL</span>
          <input
            className="settings-input"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder={DEFAULT_POSTIZ_BASE_URL}
            spellCheck={false}
          />
        </label>
        {error && <span className="settings-feedback is-err">{error}</span>}
      </section>
    </div>
  );
}

/* ---- State D: workbench ---- */

interface MediaItem {
  /** Absolute workspace path (from fs_list_dir). */
  path: string;
  name: string;
  isImage: boolean;
}

function Workbench() {
  // Compose
  const [text, setText] = useState("");
  const [aiTopic, setAiTopic] = useState("");
  const [aiBusy, setAiBusy] = useState(false);
  const [imaginePrompt, setImaginePrompt] = useState("");
  const [imagineSlug, setImagineSlug] = useState("");
  const [imagineBusy, setImagineBusy] = useState(false);
  const [media, setMedia] = useState<MediaItem[]>([]);
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // Queue
  const [channels, setChannels] = useState<PostizChannel[] | null>(null);
  const [posts, setPosts] = useState<PostizPost[] | null>(null);
  // Send
  const [channelId, setChannelId] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [wbError, setWbError] = useState<string | null>(null);
  const thumbUrlsRef = useRef<string[]>([]);

  // Revoke blob URLs on unmount.
  useEffect(() => {
    const urls = thumbUrlsRef.current;
    return () => urls.forEach((u) => URL.revokeObjectURL(u));
  }, []);

  const refreshMedia = useCallback(async () => {
    try {
      const entries = await fsListDir(MEDIA_DIR);
      const items = entries
        .filter((e) => !e.is_dir && MEDIA_EXT.test(e.name))
        .map((e) => ({ path: e.path, name: e.name, isImage: IMAGE_EXT.test(e.name) }));
      setMedia(items);
      // Build blob-URL thumbnails for images (best effort, capped count).
      const next: Record<string, string> = {};
      for (const item of items.filter((i) => i.isImage).slice(0, 24)) {
        try {
          const b64 = await fsReadBinary(item.path);
          const bytes = base64ToBytes(b64);
          const url = URL.createObjectURL(new Blob([bytes.buffer as ArrayBuffer]));
          thumbUrlsRef.current.push(url);
          next[item.path] = url;
        } catch {
          // Unreadable file — no thumbnail.
        }
      }
      setThumbs(next);
    } catch {
      setMedia([]); // social-media/ doesn't exist yet
      setThumbs({});
    }
  }, []);

  const refreshQueue = useCallback(async () => {
    try {
      const ch = await listChannels();
      setChannels(ch);
      setWbError(null);
    } catch (err) {
      setChannels(null);
      setWbError(String(err));
    }
    try {
      setPosts(await listRecentPosts());
    } catch {
      setPosts(null); // older Postiz without the posts endpoint — show "—"
    }
  }, []);

  useEffect(() => {
    void refreshMedia();
    void refreshQueue();
  }, [refreshMedia, refreshQueue]);

  const draftWithAi = useCallback(async () => {
    const topic = aiTopic.trim();
    if (!topic || aiBusy) return;
    setAiBusy(true);
    setWbError(null);
    try {
      const configs = loadProviderConfigs();
      let lastErr: unknown = null;
      for (const config of configs) {
        const apiKey = await keyGet(config.id);
        if (!apiKey) continue;
        try {
          const reply = await chatCompletion(
            config,
            apiKey,
            [
              {
                role: "user",
                content: `Write a single X (Twitter) post about the following, max ${X_CHAR_LIMIT} characters, no hashtags unless essential. Return only the post text.\n\n${topic}`,
              },
            ],
            []
          );
          setText(reply.content.trim());
          return;
        } catch (err) {
          lastErr = err;
        }
      }
      throw lastErr ?? new Error("No provider API key found — add one in Settings.");
    } catch (err) {
      setWbError(String(err));
    } finally {
      setAiBusy(false);
    }
  }, [aiTopic, aiBusy]);

  const doImagine = useCallback(async () => {
    const prompt = imaginePrompt.trim();
    const slug = imagineSlug.trim();
    if (!prompt || !slug || imagineBusy) return;
    setImagineBusy(true);
    setWbError(null);
    try {
      const result = await generateImage(prompt, slug);
      setNotice(`Image generated: ${result.filePath}`);
      setImaginePrompt("");
      setImagineSlug("");
      await refreshMedia();
    } catch (err) {
      setWbError(String(err));
    } finally {
      setImagineBusy(false);
    }
  }, [imaginePrompt, imagineSlug, imagineBusy, refreshMedia]);

  const toggleMedia = useCallback((path: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const doSend = useCallback(async () => {
    setSending(true);
    setWbError(null);
    setNotice(null);
    try {
      const result = await createDraft({
        text,
        mediaPaths: [...selected],
        channelId,
      });
      setNotice(`${result} — review and publish it in the Postiz UI.`);
      setConfirming(false);
      setText("");
      setSelected(new Set());
      await refreshQueue();
    } catch (err) {
      setWbError(String(err));
    } finally {
      setSending(false);
    }
  }, [text, selected, channelId, refreshQueue]);

  const overLimit = text.length > X_CHAR_LIMIT;
  const canSend = !!text.trim() && !overLimit && !!channelId && !sending;
  const selectedMedia = media.filter((m) => selected.has(m.path));

  return (
    <div className="soc-grid">
      {/* Compose */}
      <section className="settings-card soc-pane">
        <h2 className="settings-card-title">Compose</h2>
        <textarea
          className="settings-input soc-textarea"
          placeholder="What’s happening?"
          value={text}
          onChange={(e) => setText(e.target.value)}
          spellCheck
        />
        <div className={`soc-charcount${overLimit ? " is-over" : ""}`}>
          {text.length}/{X_CHAR_LIMIT}
        </div>

        <div className="settings-field">
          <span className="settings-label">Draft text with AI</span>
          <div className="settings-key-row">
            <input
              className="settings-input"
              placeholder="Topic for the AI draft…"
              value={aiTopic}
              onChange={(e) => setAiTopic(e.target.value)}
              spellCheck={false}
            />
            <button
              className="settings-btn"
              disabled={!aiTopic.trim() || aiBusy}
              onClick={() => void draftWithAi()}
            >
              {aiBusy ? "Drafting…" : "Draft"}
            </button>
          </div>
        </div>

        <div className="settings-field">
          <span className="settings-label">Media (social-media/)</span>
          {media.length === 0 ? (
            <span className="muted soc-p">No media yet — generate an image below.</span>
          ) : (
            <div className="soc-media-grid">
              {media.map((m) => (
                <button
                  key={m.path}
                  className={`soc-thumb${selected.has(m.path) ? " is-selected" : ""}`}
                  title={m.name}
                  onClick={() => toggleMedia(m.path)}
                >
                  {m.isImage && thumbs[m.path] ? (
                    <img src={thumbs[m.path]} alt={m.name} />
                  ) : (
                    <span className="soc-thumb-label">
                      {m.isImage ? "img" : "vid"} {m.name}
                    </span>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="settings-field">
          <span className="settings-label">Generate image (Grok Imagine)</span>
          <input
            className="settings-input"
            placeholder="Image prompt…"
            value={imaginePrompt}
            onChange={(e) => setImaginePrompt(e.target.value)}
            spellCheck={false}
          />
          <div className="settings-key-row">
            <input
              className="settings-input"
              placeholder="slug (filename)"
              value={imagineSlug}
              onChange={(e) => setImagineSlug(e.target.value)}
              spellCheck={false}
            />
            <button
              className="settings-btn"
              disabled={!imaginePrompt.trim() || !imagineSlug.trim() || imagineBusy}
              onClick={() => void doImagine()}
            >
              {imagineBusy ? "Generating…" : "Generate"}
            </button>
          </div>
        </div>
      </section>

      {/* Queue */}
      <section className="settings-card soc-pane">
        <h2 className="settings-card-title">
          Queue
          <button className="icon-btn" title="Refresh" onClick={() => void refreshQueue()}>
            ⟳
          </button>
        </h2>
        <div className="settings-field">
          <span className="settings-label">Channels</span>
          {channels === null ? (
            <span className="muted soc-p">—</span>
          ) : channels.length === 0 ? (
            <span className="muted soc-p">
              No channels connected — add one in the{" "}
              <button className="ds-link" onClick={() => void openUrl(POSTIZ_UI_URL)}>
                Postiz UI
              </button>
              .
            </span>
          ) : (
            <ul className="soc-list">
              {channels.map((c) => (
                <li key={c.id}>
                  <span className={`settings-dot${c.disabled ? "" : " is-set"}`} /> {c.provider} —{" "}
                  {c.name}
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="settings-field">
          <span className="settings-label">Recent posts &amp; drafts</span>
          {posts === null ? (
            <span className="muted soc-p">—</span>
          ) : posts.length === 0 ? (
            <span className="muted soc-p">Nothing yet.</span>
          ) : (
            <ul className="soc-list">
              {posts.slice(0, 20).map((p) => (
                <li key={p.id} title={p.content}>
                  <span className="soc-post-state">{p.state}</span> {p.content.slice(0, 60) || "(media)"}
                  {p.channel ? ` · ${p.channel}` : ""}
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      {/* Send */}
      <section className="settings-card soc-pane">
        <h2 className="settings-card-title">Send</h2>
        <label className="settings-field">
          <span className="settings-label">Channel</span>
          <select
            className="settings-input"
            value={channelId}
            onChange={(e) => setChannelId(e.target.value)}
          >
            <option value="">Select a channel…</option>
            {(channels ?? []).map((c) => (
              <option key={c.id} value={c.id} disabled={c.disabled}>
                {c.provider} — {c.name}
              </option>
            ))}
          </select>
        </label>
        <p className="muted soc-p">
          Creates a <strong>draft</strong> in Postiz — a human reviews and publishes it there.
          This UI never posts live.
        </p>
        <div className="ds-actions">
          <button className="settings-btn" disabled={!canSend} onClick={() => setConfirming(true)}>
            Send to Postiz as draft
          </button>
        </div>
        {notice && <span className="settings-feedback is-ok">{notice}</span>}
        {wbError && <span className="settings-feedback is-err">{wbError}</span>}

        {confirming && (
          <div className="approval-card soc-confirm">
            <div className="approval-title">Create draft in Postiz?</div>
            <div className="approval-label muted">
              channel {(channels ?? []).find((c) => c.id === channelId)?.name ?? channelId}
              {selectedMedia.length > 0 &&
                ` · media: ${selectedMedia.map((m) => m.name).join(", ")}`}
            </div>
            <pre className="approval-body">{text}</pre>
            <div className="approval-actions">
              <button className="approval-btn approve" disabled={sending} onClick={() => void doSend()}>
                {sending ? "Sending…" : "Confirm draft"}
              </button>
              <button
                className="approval-btn deny"
                disabled={sending}
                onClick={() => setConfirming(false)}
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
