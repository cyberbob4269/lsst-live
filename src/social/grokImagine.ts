// Grok Imagine media generation (Phase 5) — TypeScript port of vera-home's
// scripts/social/xai_imagine.py, keeping the exact endpoint/payload shapes:
//
//   image:  POST {xaiBaseUrl}/images/generations
//             { model, prompt, n: 1, aspect_ratio?, resolution? }
//             → data[0].url (downloaded) or data[0].b64_json
//   video:  POST {xaiBaseUrl}/videos/generations
//             { model, prompt, duration, aspect_ratio, resolution }
//             → { request_id }, then poll GET {xaiBaseUrl}/videos/{request_id}
//             every 5 s until status done/failed/expired (3 min timeout here)
//             → video.url (downloaded)
//
// Generated files land in the workspace `social-media/` dir via
// fs_write_binary, and each generation updates `social-media/catalog.json`
// (read-modify-write) with { slug, prompt, file, createdAt, kind }.
//
// The base URL comes from the Settings provider config (xAI entry); the API
// key comes from the OS credential store via key_get("xai") — never from
// disk, never logged.

import { fetch } from "@tauri-apps/plugin-http";
import { keyGet } from "../agent/ipc";
import { loadProviderConfigs } from "../agent/providers";
import { fsReadFile, fsWriteBinary, fsWriteFile } from "../ide/ipc";
import { arrayBufferToBase64 } from "./binary";

const OUT_DIR = "social-media";
const CATALOG_PATH = `${OUT_DIR}/catalog.json`;

const IMAGE_MODEL = "grok-imagine-image-quality";
const VIDEO_MODEL = "grok-imagine-video";
const DEFAULT_ASPECT = "9:16";
const IMAGE_RESOLUTION = "2k";

const REQUEST_TIMEOUT_MS = 120_000;
const VIDEO_POLL_INTERVAL_MS = 5_000;
const VIDEO_TIMEOUT_MS = 180_000;

export interface ImagineResult {
  /** Workspace-relative path of the saved file (e.g. social-media/x.png). */
  filePath: string;
  remoteUrl: string;
}

export interface VideoOptions {
  /** Seconds, clamped to 1..15 like the Python script. Default 8. */
  duration?: number;
  aspect?: string;
  resolution?: "480p" | "720p" | "1080p";
}

interface CatalogEntry {
  slug: string;
  prompt: string;
  file: string;
  createdAt: string;
  kind: "image" | "video";
}

async function xaiAuth(): Promise<{ baseUrl: string; apiKey: string }> {
  const config = loadProviderConfigs().find((c) => c.id === "xai");
  const baseUrl = (config?.baseUrl ?? "https://api.x.ai/v1").replace(/\/$/, "");
  const apiKey = await keyGet("xai");
  if (!apiKey) {
    throw new Error("Add your xAI key in Settings before generating media.");
  }
  return { baseUrl, apiKey };
}

async function postJson<T>(url: string, apiKey: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) {
    const text = (await res.text()).slice(0, 500);
    throw new Error(`xAI API HTTP ${res.status} — ${text}`);
  }
  return (await res.json()) as T;
}

/** Download a remote media URL into the workspace via fs_write_binary. */
async function downloadToWorkspace(remoteUrl: string, relPath: string): Promise<void> {
  const res = await fetch(remoteUrl, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (!res.ok) {
    throw new Error(`media download HTTP ${res.status}`);
  }
  const buf = await res.arrayBuffer();
  await fsWriteBinary(relPath, arrayBufferToBase64(buf));
}

/** Read-modify-write the catalog; tolerates a missing/corrupt file. */
async function updateCatalog(entry: CatalogEntry): Promise<void> {
  let items: CatalogEntry[] = [];
  try {
    const raw = await fsReadFile(CATALOG_PATH);
    const parsed = JSON.parse(raw.content) as { items?: CatalogEntry[] };
    if (Array.isArray(parsed.items)) items = parsed.items;
  } catch {
    // Missing or corrupt catalog — start fresh.
  }
  items = [...items.filter((e) => e.slug !== entry.slug), entry];
  await fsWriteFile(CATALOG_PATH, JSON.stringify({ items }, null, 2) + "\n");
}

export async function generateImage(
  prompt: string,
  slug: string,
  aspect: string = DEFAULT_ASPECT
): Promise<ImagineResult> {
  const { baseUrl, apiKey } = await xaiAuth();
  const data = await postJson<{ data?: { url?: string; b64_json?: string }[] }>(
    `${baseUrl}/images/generations`,
    apiKey,
    { model: IMAGE_MODEL, prompt, n: 1, aspect_ratio: aspect, resolution: IMAGE_RESOLUTION }
  );
  const item = data.data?.[0];
  const filePath = `${OUT_DIR}/${slug}.png`;
  let remoteUrl = "";
  if (item?.b64_json) {
    await fsWriteBinary(filePath, item.b64_json);
  } else {
    remoteUrl = item?.url ?? "";
    if (!remoteUrl) {
      throw new Error(`no image URL in response: ${JSON.stringify(data).slice(0, 300)}`);
    }
    await downloadToWorkspace(remoteUrl, filePath);
  }
  await updateCatalog({
    slug,
    prompt: prompt.slice(0, 500),
    file: filePath,
    createdAt: new Date().toISOString(),
    kind: "image",
  });
  return { filePath, remoteUrl };
}

interface VideoStartResponse {
  request_id?: string;
}

interface VideoPollResponse {
  status?: string;
  video?: { url?: string; duration?: number };
}

export async function generateVideo(
  prompt: string,
  slug: string,
  opts: VideoOptions = {}
): Promise<ImagineResult> {
  const { baseUrl, apiKey } = await xaiAuth();
  const duration = Math.max(1, Math.min(15, opts.duration ?? 8));
  const start = await postJson<VideoStartResponse>(
    `${baseUrl}/videos/generations`,
    apiKey,
    {
      model: VIDEO_MODEL,
      prompt,
      duration,
      aspect_ratio: opts.aspect ?? DEFAULT_ASPECT,
      resolution: opts.resolution ?? "1080p",
    }
  );
  const requestId = start.request_id;
  if (!requestId) {
    throw new Error(`no request_id in response: ${JSON.stringify(start).slice(0, 300)}`);
  }

  const deadline = Date.now() + VIDEO_TIMEOUT_MS;
  let result: VideoPollResponse | null = null;
  while (Date.now() < deadline) {
    const res = await fetch(`${baseUrl}/videos/${requestId}`, {
      headers: { authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(60_000),
    });
    if (res.status !== 200 && res.status !== 202) {
      const text = (await res.text()).slice(0, 500);
      throw new Error(`video poll HTTP ${res.status} — ${text}`);
    }
    const data = (await res.json()) as VideoPollResponse;
    if (data.status === "done") {
      result = data;
      break;
    }
    if (data.status === "failed" || data.status === "expired") {
      throw new Error(`video generation ${data.status}: ${JSON.stringify(data).slice(0, 500)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, VIDEO_POLL_INTERVAL_MS));
  }
  if (!result) {
    throw new Error(
      `video poll timeout after ${Math.round(VIDEO_TIMEOUT_MS / 1000)}s (request_id=${requestId})`
    );
  }

  const remoteUrl = result.video?.url ?? "";
  if (!remoteUrl) {
    throw new Error(`no video URL in response: ${JSON.stringify(result).slice(0, 300)}`);
  }
  const filePath = `${OUT_DIR}/${slug}.mp4`;
  await downloadToWorkspace(remoteUrl, filePath);
  await updateCatalog({
    slug,
    prompt: prompt.slice(0, 500),
    file: filePath,
    createdAt: new Date().toISOString(),
    kind: "video",
  });
  return { filePath, remoteUrl };
}
