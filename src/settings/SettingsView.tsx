// Settings view (Phase 3): one card per provider. API keys go to the OS
// credential store via key_set/key_delete (never to disk, never logged);
// base URLs and models are plain text and persist via
// loadProviderConfigs/saveProviderConfigs in ../agent/providers.ts — both to
// localStorage and to the workspace `.vera/settings.json` file.

import { useCallback, useEffect, useState } from "react";
import {
  chatCompletion,
  loadProviderConfigs,
  loadProviderConfigsFromDisk,
  saveProviderConfigs,
} from "../agent/providers";
import type { ProviderConfig, ProviderId } from "../agent/providers";
import { keyDelete, keyGet, keySet, keyStatus } from "../agent/ipc";

interface Feedback {
  kind: "ok" | "err" | "busy";
  text: string;
}

export default function SettingsView() {
  const [configs, setConfigs] = useState<ProviderConfig[]>(loadProviderConfigs);
  const [hasKeys, setHasKeys] = useState<Record<string, boolean>>({});
  const [keyInputs, setKeyInputs] = useState<Record<string, string>>({});
  const [feedback, setFeedback] = useState<Record<string, Feedback>>({});

  // The workspace settings file overrides localStorage (it is shared across
  // app identities) — hydrate once on mount.
  useEffect(() => {
    let cancelled = false;
    loadProviderConfigsFromDisk()
      .then((disk) => {
        if (!cancelled) setConfigs(disk);
      })
      .catch((err) => console.error("[vera] settings load failed", err));
    return () => {
      cancelled = true;
    };
  }, []);

  const refreshKeys = useCallback(() => {
    keyStatus()
      .then((rows) => {
        const map: Record<string, boolean> = {};
        for (const r of rows) map[r.provider] = r.has_key;
        setHasKeys(map);
      })
      .catch((err) => console.error("[vera] key_status failed", err));
  }, []);

  useEffect(refreshKeys, [refreshKeys]);

  const say = useCallback((id: ProviderId, fb: Feedback | null) => {
    setFeedback((prev) => {
      const next = { ...prev };
      if (fb) next[id] = fb;
      else delete next[id];
      return next;
    });
  }, []);

  const updateConfig = useCallback(
    (id: ProviderId, patch: Partial<Pick<ProviderConfig, "baseUrl" | "model">>) => {
      setConfigs((prev) => {
        const next = prev.map((c) => (c.id === id ? { ...c, ...patch } : c));
        saveProviderConfigs(next);
        return next;
      });
    },
    []
  );

  const saveKey = useCallback(
    async (id: ProviderId) => {
      const value = (keyInputs[id] ?? "").trim();
      if (!value) return;
      try {
        await keySet(id, value);
        setKeyInputs((prev) => ({ ...prev, [id]: "" }));
        say(id, { kind: "ok", text: "Key saved to the OS credential store." });
      } catch (err) {
        say(id, { kind: "err", text: String(err) });
      }
      refreshKeys();
    },
    [keyInputs, say, refreshKeys]
  );

  const deleteKey = useCallback(
    async (id: ProviderId) => {
      try {
        await keyDelete(id);
        say(id, { kind: "ok", text: "Key deleted." });
      } catch (err) {
        say(id, { kind: "err", text: String(err) });
      }
      refreshKeys();
    },
    [say, refreshKeys]
  );

  const test = useCallback(
    async (config: ProviderConfig) => {
      say(config.id, { kind: "busy", text: "Testing…" });
      try {
        const apiKey = await keyGet(config.id);
        if (!apiKey) {
          say(config.id, { kind: "err", text: "Save an API key first." });
          return;
        }
        const t0 = Date.now();
        const reply = await chatCompletion(
          config,
          apiKey,
          [{ role: "user", content: "Reply with exactly: OK" }],
          []
        );
        const ms = Date.now() - t0;
        say(config.id, {
          kind: "ok",
          text: `Success in ${ms} ms — model replied: "${reply.content.trim().slice(0, 60)}"`,
        });
      } catch (err) {
        say(config.id, { kind: "err", text: String(err) });
      }
    },
    [say]
  );

  return (
    <div className="settings-wrap">
      <div className="settings-grid">
        {configs.map((c) => {
          const fb = feedback[c.id];
          return (
            <section key={c.id} className="settings-card">
              <header className="settings-card-head">
                <span
                  className={`settings-dot${hasKeys[c.id] ? " is-set" : ""}`}
                  title={hasKeys[c.id] ? "API key stored" : "No API key stored"}
                />
                <h2 className="settings-card-title">{c.label}</h2>
              </header>

              <label className="settings-field">
                <span className="settings-label">API key</span>
                <div className="settings-key-row">
                  <input
                    type="password"
                    className="settings-input"
                    placeholder={hasKeys[c.id] ? "•••••••• (saved)" : "Paste API key…"}
                    value={keyInputs[c.id] ?? ""}
                    onChange={(e) =>
                      setKeyInputs((prev) => ({ ...prev, [c.id]: e.target.value }))
                    }
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void saveKey(c.id);
                    }}
                    autoComplete="off"
                    spellCheck={false}
                  />
                  <button
                    className="settings-btn"
                    disabled={!(keyInputs[c.id] ?? "").trim()}
                    onClick={() => void saveKey(c.id)}
                  >
                    Save
                  </button>
                  <button
                    className="settings-btn is-danger"
                    disabled={!hasKeys[c.id]}
                    onClick={() => void deleteKey(c.id)}
                  >
                    Delete
                  </button>
                </div>
              </label>

              <label className="settings-field">
                <span className="settings-label">Base URL</span>
                <input
                  className="settings-input"
                  value={c.baseUrl}
                  onChange={(e) => updateConfig(c.id, { baseUrl: e.target.value })}
                  spellCheck={false}
                />
              </label>

              <label className="settings-field">
                <span className="settings-label">Model</span>
                <input
                  className="settings-input"
                  value={c.model}
                  onChange={(e) => updateConfig(c.id, { model: e.target.value })}
                  spellCheck={false}
                />
              </label>

              <div className="settings-test-row">
                <button className="settings-btn" onClick={() => void test(c)}>
                  Test
                </button>
                {fb && (
                  <span
                    className={`settings-feedback is-${fb.kind}`}
                    role={fb.kind === "err" ? "alert" : undefined}
                  >
                    {fb.text}
                  </span>
                )}
              </div>
            </section>
          );
        })}
      </div>
      <p className="settings-note muted">
        Keys are stored in the OS credential store (service “vera-terminal”) and
        never written to disk. Provider API calls go through the Rust proxy
        (Windows-native TLS); custom base URLs must match its host allowlist in
        src-tauri/src/http_proxy.rs. The http scope in
        src-tauri/capabilities/default.json still applies to localhost and
        Postiz calls.
      </p>
    </div>
  );
}
