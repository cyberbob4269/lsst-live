// Workspace-file-backed persistence for non-secret app settings (Phase 6
// polish). localStorage is per-app-identity — the dev build and the installed
// app have SEPARATE stores — so durable settings live in the workspace at
// `.vera/settings.json`, which both identities share.
//
// SECURITY: this file must NEVER contain API keys or other secrets. Keys live
// in the OS credential store only (see ./ipc.ts key_set/key_get); only plain
// non-secret preferences (base URLs, model names, UI toggles) belong here.

import { fsEnsureDir, fsReadFile, fsWriteFile } from "../ide/ipc";

const VERA_DIR = ".vera";
const SETTINGS_PATH = ".vera/settings.json";

/** Schema of `.vera/settings.json`. Every field is optional on read — partial
 *  or older files merge onto these empty defaults. */
export interface SettingsFile {
  providers: Record<string, { baseUrl?: string; model?: string }>;
  chat: {
    selectedProviderId: string | null;
    autoApproveReads: boolean | null;
    speakReplies: boolean | null;
  };
  welcome: {
    /** Phase 7: when true, the app boots straight to the IDE even while
     *  first-run setup is incomplete. */
    dontShowOnBoot: boolean | null;
  };
  backend: {
    /** Local vera-home checkout used to spawn the dashboard backend (optional). */
    veraHomePath: string | null;
  };
}

const EMPTY_SETTINGS: SettingsFile = {
  providers: {},
  chat: { selectedProviderId: null, autoApproveReads: null, speakReplies: null },
  welcome: { dontShowOnBoot: null },
  backend: { veraHomePath: null },
};

/** Read `.vera/settings.json`; returns null when missing or corrupt (callers
 *  then fall back to localStorage / built-in defaults). */
export async function loadSettingsFile(): Promise<SettingsFile | null> {
  try {
    const file = await fsReadFile(SETTINGS_PATH);
    const raw = JSON.parse(file.content) as Partial<SettingsFile>;
    return {
      providers: raw.providers ?? {},
      chat: {
        selectedProviderId: raw.chat?.selectedProviderId ?? null,
        autoApproveReads: raw.chat?.autoApproveReads ?? null,
        speakReplies: raw.chat?.speakReplies ?? null,
      },
      welcome: {
        dontShowOnBoot: raw.welcome?.dontShowOnBoot ?? null,
      },
      backend: {
        veraHomePath: raw.backend?.veraHomePath ?? null,
      },
    };
  } catch {
    return null;
  }
}

/** Merge `patch` into `.vera/settings.json` and write it back, creating
 *  `.vera/` first. Failures are logged, never thrown — a persistence hiccup
 *  must not break the UI. */
export async function saveSettingsFile(patch: {
  providers?: SettingsFile["providers"];
  chat?: Partial<SettingsFile["chat"]>;
  welcome?: Partial<SettingsFile["welcome"]>;
  backend?: Partial<SettingsFile["backend"]>;
}): Promise<void> {
  try {
    const current = (await loadSettingsFile()) ?? EMPTY_SETTINGS;
    const next: SettingsFile = {
      providers: patch.providers ?? current.providers,
      chat: { ...current.chat, ...patch.chat },
      welcome: { ...current.welcome, ...patch.welcome },
      backend: { ...current.backend, ...patch.backend },
    };
    await fsEnsureDir(VERA_DIR);
    await fsWriteFile(SETTINGS_PATH, JSON.stringify(next, null, 2));
  } catch (err) {
    console.error("[vera] settings save failed", err);
  }
}
