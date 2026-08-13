// Welcome view (Phase 7): first-run setup concierge. Scripted and fully
// deterministic — NO LLM is involved in the wizard itself, so it works with
// zero API keys configured.
//
// Step model: providers → docker → postiz → backend → done. Every step's
// status comes from a real probe — key_status (LLM keys in the OS credential
// store), postiz_status (docker CLI / .env / containers / health) and
// vera_backend_status — never from wizard-local bookkeeping, so a returning
// user resumes exactly where things actually stand. Each card has a SKIP
// escape hatch (session-only) and auto-advances on success; providers and
// postiz hold after a user-initiated action so the ✓ and follow-up hints
// don't flash by.
//
// Keep-alive like the other top-level views: probes fire on becoming visible,
// and a light 4 s poll runs only while a start action is in flight (Postiz
// containers up but not healthy yet, backend spawned but not healthy yet).

import { useCallback, useEffect, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  chatCompletion,
  loadProviderConfigs,
  loadProviderConfigsFromDisk,
  type ProviderConfig,
  type ProviderId,
} from "../agent/providers";
import { keySet, keyStatus } from "../agent/ipc";
import { loadSettingsFile, saveSettingsFile } from "../agent/settingsStore";
import {
  postizStart,
  postizStatus,
  postizWriteEnv,
  type PostizStatus,
} from "../social/ipc";
import {
  veraBackendStart,
  veraBackendStatus,
  type BackendStatus,
} from "../deepspace/ipc";

const DOCKER_DESKTOP_URL = "https://www.docker.com/products/docker-desktop/";
const POLL_MS = 4000;
/** key_status also reports "postiz" — only the four LLM providers count as
 *  "a brain" for setup purposes. */
const LLM_PROVIDERS: ProviderId[] = ["xai", "openai", "anthropic", "kimi"];
const PROVIDER_KEY_URLS: Record<ProviderId, string> = {
  xai: "https://console.x.ai/",
  openai: "https://platform.openai.com/api-keys",
  anthropic: "https://console.anthropic.com/",
  kimi: "https://platform.moonshot.ai/",
};

type StepId = "providers" | "docker" | "postiz" | "backend" | "done";

const STEP_ORDER: StepId[] = ["providers", "docker", "postiz", "backend"];

const STEP_META: Array<{ id: StepId; label: string }> = [
  { id: "providers", label: "Brain" },
  { id: "docker", label: "Docker" },
  { id: "postiz", label: "Postiz" },
  { id: "backend", label: "Backend" },
];

/** Neutral one-liners for the done step's "anytime later" list — no shame. */
const LATER_COPY: Record<string, string> = {
  providers: "Add an AI provider key (here or in Settings) for chat and agent tools.",
  docker: "Install Docker Desktop (optional — only needed for social posting).",
  postiz: "Set up Postiz for social posting (optional).",
  backend: "Set a vera-home path in Settings and start the local backend (optional).",
};

interface KeyFeedback {
  kind: "ok" | "err" | "busy";
  text: string;
}

/** Fresh 64-hex-char secret for Postiz's JWT_SECRET (generated in the
 *  webview; the Rust side only writes it into the .env template). */
function generateJwtSecret(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export default function WelcomeView({
  visible,
  onOpenIde,
  onOpenSocial,
}: {
  visible: boolean;
  onOpenIde: () => void;
  onOpenSocial: () => void;
}) {
  /* ---- probes ---- */
  const [keys, setKeys] = useState<Record<string, boolean>>({});
  const [postiz, setPostiz] = useState<PostizStatus | null>(null);
  const [backend, setBackend] = useState<BackendStatus | null>(null);

  /* ---- step machine ---- */
  const [current, setCurrent] = useState<StepId>("providers");
  const [skipped, setSkipped] = useState<ReadonlySet<StepId>>(new Set());
  /** Blocks auto-advance after a user-initiated action (key save, Postiz
   *  start) so the success state and follow-up hints stay on screen until
   *  the user presses Continue. */
  const [holdStep, setHoldStep] = useState(false);

  /* ---- provider step ---- */
  const [configs, setConfigs] = useState<ProviderConfig[]>(loadProviderConfigs);
  const [providerId, setProviderId] = useState<ProviderId>("xai");
  const [keyInput, setKeyInput] = useState("");
  const [keyFeedback, setKeyFeedback] = useState<KeyFeedback | null>(null);
  const [keyBusy, setKeyBusy] = useState(false);
  /** Providers that passed a live test this session (for the done summary). */
  const [connected, setConnected] = useState<string[]>([]);

  /* ---- postiz step ---- */
  const [xKey, setXKey] = useState("");
  const [xSecret, setXSecret] = useState("");
  const [envPath, setEnvPath] = useState<string | null>(null);
  const [envError, setEnvError] = useState<string | null>(null);
  const [envBusy, setEnvBusy] = useState(false);
  const [startBusy, setStartBusy] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);

  /* ---- backend step ---- */
  const [beBusy, setBeBusy] = useState(false);
  const [beError, setBeError] = useState<string | null>(null);
  const [veraHomePath, setVeraHomePath] = useState<string | null>(null);

  /* ---- boot preference ---- */
  const [dontShow, setDontShow] = useState(false);

  const refreshKeys = useCallback(async () => {
    try {
      const rows = await keyStatus();
      const map: Record<string, boolean> = {};
      for (const r of rows) map[r.provider] = r.has_key;
      setKeys(map);
    } catch (err) {
      console.error("[vera] welcome key_status failed", err);
    }
  }, []);

  const refreshPostiz = useCallback(async () => {
    try {
      setPostiz(await postizStatus());
    } catch (err) {
      console.error("[vera] welcome postiz_status failed", err);
    }
  }, []);

  const refreshBackend = useCallback(async () => {
    try {
      setBackend(await veraBackendStatus());
    } catch (err) {
      console.error("[vera] welcome vera_backend_status failed", err);
    }
  }, []);

  // Probe once whenever the view becomes visible (also covers first mount).
  useEffect(() => {
    if (!visible) return;
    void refreshKeys();
    void refreshPostiz();
    void refreshBackend();
  }, [visible, refreshKeys, refreshPostiz, refreshBackend]);

  // Hydrate the boot preference and the disk-backed provider configs once.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [file, disk] = await Promise.all([
          loadSettingsFile(),
          loadProviderConfigsFromDisk(),
        ]);
        if (cancelled) return;
        setDontShow(file?.welcome.dontShowOnBoot ?? false);
        setConfigs(disk);
        setVeraHomePath(file?.backend.veraHomePath?.trim() || null);
      } catch (err) {
        console.error("[vera] welcome settings hydrate failed", err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  /* ---- derived step status (from probes only) ---- */
  const anyKey = LLM_PROVIDERS.some((id) => keys[id]);
  const dockerOk = postiz?.dockerAvailable ?? false;
  const postizOk = !!postiz && postiz.state === "running" && postiz.healthy;
  const backendOk = backend?.healthy ?? false;
  const hasBackendPath = Boolean(veraHomePath);
  const doneMap: Record<StepId, boolean> = {
    providers: anyKey,
    docker: dockerOk,
    postiz: postizOk,
    backend: backendOk || !hasBackendPath,
    done: true,
  };

  /** Advance to the first step after `from` that is neither done nor skipped. */
  const gotoNext = useCallback(
    (from: StepId, alsoSkip?: StepId) => {
      const done: Record<string, boolean> = {
        providers: anyKey,
        docker: dockerOk,
        postiz: postizOk,
        backend: backendOk || !hasBackendPath,
      };
      const skipSet = new Set(skipped);
      if (alsoSkip) skipSet.add(alsoSkip);
      const idx = STEP_ORDER.indexOf(from);
      for (let i = idx + 1; i < STEP_ORDER.length; i++) {
        const s = STEP_ORDER[i];
        if (!done[s] && !skipSet.has(s)) {
          setCurrent(s);
          return;
        }
      }
      setCurrent("done");
    },
    [anyKey, dockerOk, postizOk, backendOk, hasBackendPath, skipped]
  );

  // Auto-advance: whenever the current step turns green, move on — except
  // while a user-initiated action is holding the step for its ✓ moment.
  const currentDone = doneMap[current];
  useEffect(() => {
    if (current === "done" || holdStep) return;
    if (currentDone) gotoNext(current);
  }, [current, holdStep, currentDone, gotoNext]);

  // Light polling, only while a start action is mid-flight: Postiz containers
  // up but not answering yet, or the backend spawned but not healthy yet.
  useEffect(() => {
    if (!visible) return;
    const postizStarting = current === "postiz" && postiz?.state === "running" && !postiz.healthy;
    const backendStarting =
      current === "backend" && !!backend && backend.mode !== "stopped" && !backend.healthy;
    if (!postizStarting && !backendStarting) return;
    const timer = setInterval(() => {
      if (postizStarting) void refreshPostiz();
      if (backendStarting) void refreshBackend();
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [visible, current, postiz, backend, refreshPostiz, refreshBackend]);

  const skipStep = useCallback(
    (step: StepId) => {
      setSkipped((prev) => new Set(prev).add(step));
      setHoldStep(false);
      gotoNext(step, step);
    },
    [gotoNext]
  );

  const continueFrom = useCallback(
    (step: StepId) => {
      setHoldStep(false);
      gotoNext(step);
    },
    [gotoNext]
  );

  /* ---- provider step actions ---- */

  const saveAndTestKey = useCallback(async () => {
    const value = keyInput.trim();
    if (!value || keyBusy) return;
    const config = configs.find((c) => c.id === providerId) ?? configs[0];
    setKeyBusy(true);
    setHoldStep(true); // keep the card put while feedback is on screen
    setKeyFeedback({ kind: "busy", text: `Saving the key and asking ${config.label} to reply…` });
    try {
      await keySet(config.id, value);
      setKeyInput("");
      const t0 = Date.now();
      const reply = await chatCompletion(
        config,
        value,
        [{ role: "user", content: "Reply with exactly: OK" }],
        []
      );
      const ms = Date.now() - t0;
      setKeyFeedback({
        kind: "ok",
        text: `✓ ${config.label} works — replied "${reply.content.trim().slice(0, 20)}" in ${ms} ms.`,
      });
      setConnected((prev) => (prev.includes(config.label) ? prev : [...prev, config.label]));
    } catch (err) {
      setKeyFeedback({
        kind: "err",
        text: `That key didn't work: ${String(err)}`,
      });
    } finally {
      setKeyBusy(false);
      void refreshKeys();
    }
  }, [keyInput, keyBusy, configs, providerId, refreshKeys]);

  const addAnotherKey = useCallback(() => {
    setKeyInput("");
    setKeyFeedback(null);
  }, []);

  /* ---- postiz step actions ---- */

  const writeEnv = useCallback(
    async (overwrite: boolean) => {
      if (envBusy) return;
      setEnvBusy(true);
      setEnvError(null);
      try {
        const path = await postizWriteEnv({
          jwtSecret: generateJwtSecret(),
          xApiKey: xKey.trim() || null,
          xApiSecret: xSecret.trim() || null,
          overwrite,
        });
        setEnvPath(path);
        await refreshPostiz();
      } catch (err) {
        setEnvError(String(err));
      } finally {
        setEnvBusy(false);
      }
    },
    [envBusy, xKey, xSecret, refreshPostiz]
  );

  const startPostiz = useCallback(async () => {
    if (startBusy) return;
    setStartBusy(true);
    setStartError(null);
    setHoldStep(true); // show "Postiz is up" + the Social pointer once healthy
    try {
      setPostiz(await postizStart());
    } catch (err) {
      setStartError(String(err));
    } finally {
      setStartBusy(false);
    }
  }, [startBusy]);

  /* ---- backend step actions ---- */

  const startBackend = useCallback(async () => {
    if (beBusy) return;
    if (!veraHomePath) {
      setBeError("Set the vera-home path in Settings first, or skip and use public labs.");
      return;
    }
    setBeBusy(true);
    setBeError(null);
    try {
      setBackend(await veraBackendStart(veraHomePath));
    } catch (err) {
      setBeError(String(err));
    } finally {
      setBeBusy(false);
    }
  }, [beBusy, veraHomePath]);

  /* ---- boot preference ---- */

  const toggleDontShow = useCallback((value: boolean) => {
    setDontShow(value);
    void saveSettingsFile({ welcome: { dontShowOnBoot: value } });
  }, []);

  /* ---- render ---- */

  const selectedConfig = configs.find((c) => c.id === providerId) ?? configs[0];
  const laterSteps = STEP_ORDER.filter((s) => !doneMap[s]);
  const connectedLabels = LLM_PROVIDERS.filter((id) => keys[id])
    .map((id) => configs.find((c) => c.id === id)?.label ?? id)
    .filter((label, i, arr) => arr.indexOf(label) === i);

  return (
    <div className="welcome-wrap">
      <div className="welcome-head">
        <div>
          <h1 className="welcome-title">Welcome to LSST Live</h1>
          <p className="muted welcome-sub">
            Deep-space dashboards, an optional AI IDE, and optional social tools.
            Everything here is skippable — explore the Dashboards tab right away
            (public labs work with no setup).
          </p>
        </div>
        <label className="chat-toggle welcome-boot">
          <input
            type="checkbox"
            checked={dontShow}
            onChange={(e) => toggleDontShow(e.target.checked)}
          />
          Don't show on startup
        </label>
      </div>

      <div className="welcome-dots" aria-label="Setup progress">
        {STEP_META.map((s, i) => (
          <div
            key={s.id}
            className={`welcome-dot${doneMap[s.id] ? " is-done" : ""}${
              current === s.id ? " is-active" : ""
            }${skipped.has(s.id) && !doneMap[s.id] ? " is-skipped" : ""}`}
          >
            <span className="welcome-dot-badge">
              {doneMap[s.id] ? "✓" : skipped.has(s.id) ? "–" : i + 1}
            </span>
            <span className="welcome-dot-label">{s.label}</span>
          </div>
        ))}
      </div>

      {current === "providers" && (
        <section className="settings-card welcome-card">
          <header className="settings-card-head">
            <span className={`settings-dot${anyKey ? " is-set" : ""}`} />
            <h2 className="settings-card-title">AI provider (optional)</h2>
          </header>
          <p className="muted soc-p">
            Paste a key from any provider for chat and agent tools. Skip this to
            use dashboards and labs without an API key.
          </p>
          {connected.length > 0 && (
            <p className="settings-feedback is-ok">Connected this session: {connected.join(", ")}</p>
          )}
          <div className="settings-field">
            <span className="settings-label">Provider</span>
            <div className="settings-key-row">
              <select
                className="settings-input"
                value={providerId}
                onChange={(e) => setProviderId(e.target.value as ProviderId)}
              >
                {configs.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.label}
                    {keys[c.id] ? " (key saved)" : ""}
                  </option>
                ))}
              </select>
              <button
                className="ds-link"
                onClick={() => void openUrl(PROVIDER_KEY_URLS[providerId])}
                title={`Get a ${selectedConfig.label} API key`}
              >
                Get a key →
              </button>
            </div>
          </div>
          <label className="settings-field">
            <span className="settings-label">API key</span>
            <div className="settings-key-row">
              <input
                type="password"
                className="settings-input"
                placeholder={keys[providerId] ? "•••••••• (saved — paste to replace)" : "Paste API key…"}
                value={keyInput}
                onChange={(e) => setKeyInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void saveAndTestKey();
                }}
                autoComplete="off"
                spellCheck={false}
              />
              <button
                className="settings-btn is-primary"
                disabled={!keyInput.trim() || keyBusy}
                onClick={() => void saveAndTestKey()}
              >
                {keyBusy ? "Testing…" : "Save & Test"}
              </button>
            </div>
          </label>
          {keyFeedback && (
            <span
              className={`settings-feedback is-${keyFeedback.kind}`}
              role={keyFeedback.kind === "err" ? "alert" : undefined}
            >
              {keyFeedback.text}
            </span>
          )}
          <div className="welcome-actions">
            {holdStep && anyKey && (
              <>
                <button className="settings-btn" onClick={addAnotherKey}>
                  Add another key
                </button>
                <button className="settings-btn is-primary" onClick={() => continueFrom("providers")}>
                  Continue →
                </button>
              </>
            )}
            <button className="ds-link" onClick={() => skipStep("providers")}>
              Skip for now
            </button>
          </div>
        </section>
      )}

      {current === "docker" && (
        <section className="settings-card welcome-card">
          <header className="settings-card-head">
            <span className={`settings-dot${dockerOk ? " is-set" : ""}`} />
            <h2 className="settings-card-title">Docker (optional — social tools)</h2>
          </header>
          <p className="muted soc-p">
            Social posting via Postiz runs in Docker containers. Skip this if you
            only want dashboards and labs.
          </p>
          {dockerOk ? (
            <p className="settings-feedback is-ok">✓ Docker found.</p>
          ) : (
            <div className="welcome-actions">
              <button
                className="settings-btn is-primary"
                onClick={() => void openUrl(DOCKER_DESKTOP_URL)}
              >
                Get Docker Desktop
              </button>
              <button className="settings-btn" onClick={() => void refreshPostiz()}>
                Re-check
              </button>
            </div>
          )}
          <div className="welcome-actions">
            <button className="ds-link" onClick={() => skipStep("docker")}>
              Skip for now
            </button>
          </div>
        </section>
      )}

      {current === "postiz" && (
        <section className="settings-card welcome-card">
          <header className="settings-card-head">
            <span className={`settings-dot${postizOk ? " is-set" : ""}`} />
            <h2 className="settings-card-title">Postiz (optional — social posting)</h2>
          </header>
          <p className="muted soc-p">
            Postiz schedules and sends posts from the Social tab. LSST Live can
            write its config file for you — one click, nothing to edit by hand.
          </p>

          {!postiz?.envPresent && (
            <>
              <label className="settings-field">
                <span className="settings-label">X/Twitter app key (optional)</span>
                <input
                  className="settings-input"
                  placeholder="Needed only if you'll post to X — you can add it later"
                  value={xKey}
                  onChange={(e) => setXKey(e.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                />
              </label>
              <label className="settings-field">
                <span className="settings-label">X/Twitter app secret (optional)</span>
                <input
                  className="settings-input"
                  placeholder="Same — leave empty for now if you like"
                  value={xSecret}
                  onChange={(e) => setXSecret(e.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                />
              </label>
              <div className="welcome-actions">
                <button
                  className="settings-btn is-primary"
                  disabled={envBusy}
                  onClick={() => void writeEnv(false)}
                >
                  {envBusy ? "Writing…" : "Set up Postiz for me"}
                </button>
              </div>
              {envError && (
                <>
                  <span className="settings-feedback is-err" role="alert">
                    {envError}
                  </span>
                  {envError.includes("already exists") && (
                    <div className="welcome-actions">
                      <button className="settings-btn" onClick={() => void writeEnv(true)}>
                        Replace the existing .env
                      </button>
                    </div>
                  )}
                </>
              )}
            </>
          )}

          {postiz?.envPresent && !postizOk && (
            <>
              {envPath && (
                <p className="settings-feedback is-ok">✓ Config written to {envPath}</p>
              )}
              {!envPath && (
                <p className="settings-feedback is-ok">✓ Config file is in place.</p>
              )}
              <div className="welcome-actions">
                <button
                  className="settings-btn is-primary"
                  disabled={startBusy}
                  onClick={() => void startPostiz()}
                >
                  {startBusy ? "Starting…" : "Start Postiz"}
                </button>
              </div>
              {startBusy && (
                <p className="muted soc-p">
                  <span className="spinner" /> Pulling images — the first run can take
                  several minutes. You can wait here; this page updates itself.
                </p>
              )}
              {!startBusy && postiz.state === "running" && !postiz.healthy && (
                <p className="muted soc-p">
                  <span className="spinner" /> Containers are up — waiting for Postiz to
                  answer on localhost:4007 (first boot runs migrations, give it a minute).
                </p>
              )}
              {startError && (
                <span className="settings-feedback is-err" role="alert">
                  {startError}
                </span>
              )}
            </>
          )}

          {postizOk && (
            <>
              <p className="settings-feedback is-ok">✓ Postiz is up.</p>
              <p className="muted soc-p">
                Last bit for social posting: create your Postiz account, connect your X
                channel and paste the API key — the Social tab walks you through it.
              </p>
              <div className="welcome-actions">
                <button className="settings-btn" onClick={onOpenSocial}>
                  Open the Social tab
                </button>
                <button className="settings-btn is-primary" onClick={() => continueFrom("postiz")}>
                  Continue →
                </button>
              </div>
            </>
          )}

          {!postizOk && (
            <div className="welcome-actions">
              <button className="ds-link" onClick={() => skipStep("postiz")}>
                Skip for now
              </button>
            </div>
          )}
        </section>
      )}

      {current === "backend" && (
        <section className="settings-card welcome-card">
          <header className="settings-card-head">
            <span className={`settings-dot${backendOk ? " is-set" : ""}`} />
            <h2 className="settings-card-title">Local dashboard backend (optional)</h2>
          </header>
          <p className="muted soc-p">
            A local vera-home checkout serves labs on 127.0.0.1:8765. Public hosted
            labs work without this — set the path in Settings if you have vera-home
            locally, then start the backend here.
          </p>
          {!hasBackendPath && (
            <p className="muted soc-p">
              No vera-home path configured.{" "}
              <button
                className="ds-link"
                onClick={() => void openUrl("https://cyberbob4269.github.io/lsst-live-site/labs/")}
              >
                Open public labs
              </button>
              {" "}
              or set the path in Settings.
            </p>
          )}
          {backendOk ? (
            <p className="settings-feedback is-ok">
              ✓ Local backend live
              {backend?.mode === "external" ? " (already running — adopted)" : ""}.
            </p>
          ) : hasBackendPath ? (
            <>
              <div className="welcome-actions">
                <button
                  className="settings-btn is-primary"
                  disabled={beBusy}
                  onClick={() => void startBackend()}
                >
                  {beBusy ? "Starting…" : "Start the backend"}
                </button>
              </div>
              {beBusy && (
                <p className="muted soc-p">
                  <span className="spinner" /> First launch can take ~30 s while the stream
                  ingest connects.
                </p>
              )}
              {beError && (
                <span className="settings-feedback is-err" role="alert">
                  {beError}
                </span>
              )}
            </>
          ) : null}
          <div className="welcome-actions">
            <button className="ds-link" onClick={() => skipStep("backend")}>
              Skip for now
            </button>
          </div>
        </section>
      )}

      {current === "done" && (
        <section className="settings-card welcome-card">
          <header className="settings-card-head">
            <h2 className="settings-card-title">You're all set</h2>
          </header>
          <ul className="soc-list">
            {anyKey && (
              <li>
                <span className="settings-dot is-set" /> AI provider connected —{" "}
                {connectedLabels.join(", ") || "API key saved"}.
              </li>
            )}
            {dockerOk && (
              <li>
                <span className="settings-dot is-set" /> Docker is installed.
              </li>
            )}
            {postizOk && (
              <li>
                <span className="settings-dot is-set" /> Postiz is up — finish connecting it
                in the Social tab (account, X channel, API key).
              </li>
            )}
            {backendOk && (
              <li>
                <span className="settings-dot is-set" /> Local dashboard backend running.
              </li>
            )}
          </ul>
          {laterSteps.length > 0 && (
            <>
              <p className="settings-label welcome-later-title">Anytime later</p>
              <ul className="soc-list muted">
                {laterSteps.map((s) => (
                  <li key={s}>{LATER_COPY[s]}</li>
                ))}
              </ul>
              <p className="muted soc-p">
                No rush — the Welcome tab stays right where you left it.
              </p>
            </>
          )}
          <div className="welcome-actions">
            <button className="settings-btn is-primary" onClick={onOpenIde}>
              Open the IDE
            </button>
          </div>
        </section>
      )}
    </div>
  );
}
