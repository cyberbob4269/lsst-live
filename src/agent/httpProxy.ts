// Typed wrapper for the Phase 6 native-TLS HTTP proxy commands (see
// src-tauri/src/http_proxy.rs). Provider-bound traffic goes through these
// instead of tauri-plugin-http: the Rust side uses reqwest with native-tls
// (schannel on Windows), which trusts the Windows root store — so
// TLS-intercepting AV (e.g. Avast Web Shield, re-signing with its own root)
// cannot break provider calls the way the plugin's bundled webpki roots did.
//
// The Rust side enforces a hardcoded host allowlist (api.x.ai,
// api.openai.com, api.anthropic.com, api.moonshot.ai/.cn, localhost,
// 127.0.0.1) and HTTPS-only outside localhost; custom provider base URLs
// must match it. HTTP error statuses come back in-band ({ status, bytes }) —
// invoke() only rejects on transport/config failures.
//
// Bodies cross the bridge as base64; the tiny helpers are colocated here
// (same shape as src/social/binary.ts, kept separate so the agent suite
// doesn't import from the social suite).

import { invoke } from "@tauri-apps/api/core";

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

export interface ProxyResult {
  /** HTTP status — present even for 4xx/5xx (check it yourself). */
  status: number;
  /** ArrayBuffer-backed so it can go straight into a Blob (TTS audio). */
  bytes: Uint8Array<ArrayBuffer>;
}

interface RawProxyResponse {
  status: number;
  bodyBase64: string;
}

/** POST to an allowlisted host. `body` is a Uint8Array, or a string which is
 *  UTF-8-encoded first (JSON payloads). */
export async function proxyPost(
  url: string,
  headers: Record<string, string>,
  body: Uint8Array | string,
  timeoutMs?: number
): Promise<ProxyResult> {
  const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
  const res = await invoke<RawProxyResponse>("proxy_post", {
    url,
    headers,
    bodyBase64: bytesToBase64(bytes),
    timeoutMs: timeoutMs ?? null,
  });
  return { status: res.status, bytes: base64ToBytes(res.bodyBase64) };
}

/** GET from an allowlisted host (video-status polling, media downloads). */
export async function proxyGet(
  url: string,
  headers: Record<string, string> = {},
  timeoutMs?: number
): Promise<ProxyResult> {
  const res = await invoke<RawProxyResponse>("proxy_get", {
    url,
    headers,
    timeoutMs: timeoutMs ?? null,
  });
  return { status: res.status, bytes: base64ToBytes(res.bodyBase64) };
}
