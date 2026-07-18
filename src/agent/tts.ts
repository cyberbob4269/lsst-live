// xAI text-to-speech ("talk back") for the chat panel — TypeScript port of
// vera-home's src/xai_tts.py, keeping the exact endpoint/payload shape:
//
//   POST https://api.x.ai/v1/tts
//     { text, voice_id: "Leo" | "Eve",
//       output_format: { codec: "mp3", sample_rate: 44100, bit_rate: 128000 },
//       language: "en" }
//     → raw MP3 bytes (played via Blob + object URL + <audio>)
//
// The API key comes from the OS credential store via key_get("xai") — never
// from disk, never logged. Only one clip plays at a time: starting a new
// clip stops the current one, and object URLs are revoked when playback
// ends or is stopped.

import { fetch } from "@tauri-apps/plugin-http";
import { keyGet } from "./ipc";

const XAI_TTS_URL = "https://api.x.ai/v1/tts";
const DEFAULT_VOICE = "Leo";
const MAX_CHARS = 1800;
const REQUEST_TIMEOUT_MS = 60_000;

interface ActiveClip {
  audio: HTMLAudioElement;
  url: string;
  /** Resolves the speakText() promise exactly once (end, stop, or error). */
  finish: (err?: Error) => void;
}

let current: ActiveClip | null = null;
/** Invalidates in-flight speakText() calls when playback is stopped. */
let seq = 0;

function clearClip(clip: ActiveClip, err?: Error): void {
  if (current === clip) current = null;
  clip.audio.onended = null;
  clip.audio.onerror = null;
  clip.audio.pause();
  URL.revokeObjectURL(clip.url);
  clip.finish(err);
}

/** True while a clip is loaded and playing (or about to play). */
export function isSpeaking(): boolean {
  return current !== null;
}

/** Stop the current clip (if any) and cancel any in-flight synthesis. The
 *  corresponding speakText() promise resolves quietly — a user stop is not
 *  an error. */
export function stopSpeaking(): void {
  seq++;
  if (current) clearClip(current);
}

/** Strip markdown syntax the voice shouldn't read: fenced code blocks,
 *  inline backticks, images, and link targets; collapse whitespace. */
export function cleanForSpeech(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\(([^)]*)\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/** Synthesize `text` with the xAI TTS API and play it. Resolves when
 *  playback ends (or stopSpeaking() is called); rejects on key/HTTP/
 *  playback errors. Any currently-playing clip is stopped first. */
export async function speakText(text: string, voice: string = DEFAULT_VOICE): Promise<void> {
  stopSpeaking();
  const my = seq;

  const apiKey = await keyGet("xai");
  if (!apiKey) {
    throw new Error("Add your xAI key in Settings to use voice.");
  }

  let payload = text.trim();
  if (!payload) throw new Error("Nothing to say.");
  if (payload.length > MAX_CHARS) {
    payload = payload.slice(0, MAX_CHARS - 3) + "...";
  }
  const voiceId = voice.toLowerCase() === "eve" ? "Eve" : DEFAULT_VOICE;

  const res = await fetch(XAI_TTS_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      text: payload,
      voice_id: voiceId,
      output_format: { codec: "mp3", sample_rate: 44100, bit_rate: 128000 },
      language: "en",
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 400);
    throw new Error(`xAI TTS HTTP ${res.status} — ${detail}`);
  }
  const buf = await res.arrayBuffer();

  // Stopped while the request was in flight — bail out quietly.
  if (my !== seq) return;

  const url = URL.createObjectURL(new Blob([buf], { type: "audio/mpeg" }));
  const audio = new Audio(url);
  await new Promise<void>((resolve, reject) => {
    const clip: ActiveClip = {
      audio,
      url,
      finish: (err) => (err ? reject(err) : resolve()),
    };
    current = clip;
    audio.onended = () => clearClip(clip);
    audio.onerror = () => clearClip(clip, new Error("Audio playback failed."));
    audio.play().catch((err: unknown) => {
      clearClip(clip, err instanceof Error ? err : new Error(String(err)));
    });
  });
}
