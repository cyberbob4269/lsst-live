// Postiz public API client (Phase 5). Talks to a self-hosted Postiz stack
// (packaging/postiz) over its public v1 API:
//
//   GET  /public/v1/integrations   — connected channels
//   POST /public/v1/upload         — media upload (multipart), → { id, path }
//   POST /public/v1/posts          — create posts; type "draft" only, v1 UI
//                                    never publishes or schedules live
//   GET  /public/v1/posts          — recent posts/drafts (date range query)
//
// Auth is the raw API key in the Authorization header — NO "Bearer " prefix
// (verified live 2026-07-18: Postiz returns 401 with it, 200 without). The
// key is created in Postiz settings (Developers → Public API) and stored in
// the OS credential store under provider "postiz". The base URL defaults to
// http://localhost:4007/api and is editable in the Social view (plain text,
// localStorage). localhost is already in the http-plugin scope.
//
// Written defensively: the base path is configurable, response shapes are
// probed (array vs wrapped), and HTTP error bodies are surfaced verbatim.

import { fetch } from "@tauri-apps/plugin-http";
import { keyGet } from "../agent/ipc";
import { fsReadBinary } from "../ide/ipc";
import { base64ToBytes } from "./binary";

const BASE_URL_KEY = "vera.social.postizBaseUrl.v1";
export const DEFAULT_POSTIZ_BASE_URL = "http://localhost:4007/api";
const REQUEST_TIMEOUT_MS = 60_000;

export function getPostizBaseUrl(): string {
  try {
    const stored = localStorage.getItem(BASE_URL_KEY);
    if (stored && stored.trim()) return stored.trim().replace(/\/$/, "");
  } catch {
    // Storage unavailable — fall back to the default.
  }
  return DEFAULT_POSTIZ_BASE_URL;
}

export function setPostizBaseUrl(url: string): void {
  try {
    localStorage.setItem(BASE_URL_KEY, url.trim());
  } catch {
    // Storage unavailable — the edit just won't persist.
  }
}

export class PostizKeyMissingError extends Error {
  constructor() {
    super("No Postiz API key saved — paste one in the Social view first.");
    this.name = "PostizKeyMissingError";
  }
}

async function apiKey(): Promise<string> {
  const key = await keyGet("postiz");
  if (!key) throw new PostizKeyMissingError();
  return key.trim(); // guard against paste whitespace
}

async function request<T>(path: string, init?: { method?: string; body?: BodyInit }): Promise<T> {
  const key = await apiKey();
  const res = await fetch(`${getPostizBaseUrl()}/public/v1${path}`, {
    method: init?.method ?? "GET",
    headers: { authorization: key },
    body: init?.body ?? null,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) {
    const text = (await res.text()).slice(0, 800);
    throw new Error(`Postiz API HTTP ${res.status} on ${path} — ${text}`);
  }
  const text = await res.text();
  if (!text.trim()) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`Postiz API returned non-JSON on ${path}: ${text.slice(0, 300)}`);
  }
}

/* ---- channels ---- */

export interface PostizChannel {
  id: string;
  name: string;
  /** e.g. "x", "linkedin" — `provider` or `identifier` depending on version. */
  provider: string;
  picture?: string;
  disabled?: boolean;
}

interface RawChannel {
  id?: string;
  name?: string;
  provider?: string;
  identifier?: string;
  picture?: string;
  disabled?: boolean;
}

function asArray<T>(data: unknown, wrapperKey: string): T[] {
  if (Array.isArray(data)) return data as T[];
  if (data && typeof data === "object") {
    const wrapped = (data as Record<string, unknown>)[wrapperKey];
    if (Array.isArray(wrapped)) return wrapped as T[];
  }
  return [];
}

export async function listChannels(): Promise<PostizChannel[]> {
  const data = await request<unknown>("/integrations");
  return asArray<RawChannel>(data, "integrations")
    .filter((c) => c.id)
    .map((c) => ({
      id: String(c.id),
      name: c.name ?? c.id ?? "?",
      provider: c.provider ?? c.identifier ?? "?",
      picture: c.picture,
      disabled: c.disabled,
    }));
}

/* ---- media upload ---- */

export interface UploadedMedia {
  id: string;
  path: string;
}

function mimeFor(fileName: string): string {
  const ext = fileName.split(".").pop()?.toLowerCase() ?? "";
  switch (ext) {
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    case "mp4":
      return "video/mp4";
    default:
      return "application/octet-stream";
  }
}

/** Upload one workspace media file; Postiz answers { id, path }. */
export async function uploadMedia(workspacePath: string): Promise<UploadedMedia> {
  const b64 = await fsReadBinary(workspacePath);
  const name = workspacePath.split("/").pop() ?? "media";
  const bytes = base64ToBytes(b64);
  const form = new FormData();
  form.append("file", new File([bytes.buffer as ArrayBuffer], name, { type: mimeFor(name) }));
  const data = await request<unknown>("/upload", { method: "POST", body: form });
  const obj = (data ?? {}) as Record<string, unknown>;
  const id = obj.id ?? obj.path;
  const path = obj.path ?? obj.id;
  if (typeof id !== "string" || typeof path !== "string") {
    throw new Error(`unexpected upload response: ${JSON.stringify(data).slice(0, 300)}`);
  }
  return { id, path };
}

/* ---- drafts ---- */

export interface DraftInput {
  text: string;
  /** Workspace paths of media files (uploaded first). */
  mediaPaths: string[];
  channelId: string;
}

/**
 * Create a DRAFT post — type is hard-coded "draft"; this client (and the v1
 * UI) never publishes or schedules live. Returns a short summary string.
 */
export async function createDraft(input: DraftInput): Promise<string> {
  const media: UploadedMedia[] = [];
  for (const path of input.mediaPaths) {
    media.push(await uploadMedia(path));
  }
  const body = {
    type: "draft",
    date: new Date().toISOString(),
    shortLink: false,
    tags: [],
    posts: [
      {
        integration: { id: input.channelId },
        value: [
          {
            content: input.text,
            image: media.map((m) => ({ id: m.id, path: m.path })),
          },
        ],
      },
    ],
  };
  const data = await request<unknown>("/posts", {
    method: "POST",
    body: JSON.stringify(body),
  });
  return `draft created on channel ${input.channelId} — ${JSON.stringify(data).slice(0, 300)}`;
}

/* ---- recent posts/drafts ---- */

export interface PostizPost {
  id: string;
  content: string;
  state: string;
  publishDate?: string;
  channel?: string;
}

export async function listRecentPosts(): Promise<PostizPost[]> {
  const end = new Date(Date.now() + 24 * 3600 * 1000);
  const start = new Date(Date.now() - 30 * 24 * 3600 * 1000);
  const data = await request<unknown>(
    `/posts?start=${encodeURIComponent(start.toISOString())}&end=${encodeURIComponent(end.toISOString())}`
  );
  return asArray<Record<string, unknown>>(data, "posts").map((p) => ({
    id: String(p.id ?? "?"),
    content: String(p.content ?? "").slice(0, 280),
    state: String(p.state ?? p.status ?? "?"),
    publishDate: typeof p.publishDate === "string" ? p.publishDate : undefined,
    channel:
      typeof p.integration === "object" && p.integration !== null
        ? String((p.integration as Record<string, unknown>).name ?? "")
        : undefined,
  }));
}
