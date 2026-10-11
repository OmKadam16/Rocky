import { describeFailure, isNetworkError, logFailure, providerErrorText, withNetRetry } from "./netErrors";
import { speakableTimes } from "./clockTalk";
import { getSecret } from "./secrets";
import { db } from "./db";
import { startTranscription } from "./transcribe";

/**
 * The conversation loop's audio, end to end, through ElevenLabs only.
 *
 * Listening goes to Scribe (see transcribe.ts); speaking goes to ElevenLabs
 * TTS. Chrome's SpeechRecognition and the browser's speechSynthesis both used
 * to sit behind these as fallbacks — they are gone deliberately. Web Speech
 * never worked in Electron, and falling back to a robotic system voice made
 * failures look like features. If ElevenLabs cannot answer, nothing is spoken
 * and the caller hears about it.
 */

/** ElevenLabs "Sarah". The Profile voice list overrides this once one is chosen. */
export const DEFAULT_VOICE_ID = "EXAVITQu4vr4xnSDxMaL";

/**
 * Flash v2.5 — ultra-fast (~75ms) streaming model for realtime replies.
 * See https://elevenlabs.io/docs/overview/models — eleven_flash_v2_5 is the
 * current low-latency TTS model (Turbo models are superseded by Flash).
 */
const TTS_MODEL = "eleven_flash_v2_5";
const TTS_OUTPUT_FORMAT = "mp3_44100_128";
const ttsStreamUrl = (voiceId: string) =>
  `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream?output_format=${TTS_OUTPUT_FORMAT}`;

export type RecognitionHandlers = {
  onPartial?: (text: string) => void;
  /** 0-1 mic level, so the UI can show something is being heard. */
  onLevel?: (level: number) => void;
  /** Fires once, the moment the user actually starts talking. */
  onSpeechStart?: () => void;
  onFinal: (text: string) => void;
  onError?: (message: string) => void;
  onEnd?: () => void;
};

export type RecognitionOptions = {
  /** Silence after speech before the turn is considered over. */
  silenceMs?: number;
  /** Kept for call-site compatibility; the recording path has no interim text. */
  settledSilenceMs?: number;
  /** How long to wait for the user to start talking at all. */
  openingMs?: number;
  /** Hard cap on a single turn. */
  maxTurnMs?: number;
  /** Tap-to-talk: pauses never end the turn, only an explicit stop does. */
  manualStop?: boolean;
};

/** Whether this device can capture a turn at all. */
export const voiceInputSupported = () =>
  Boolean(navigator.mediaDevices?.getUserMedia) && typeof MediaRecorder !== "undefined";

/**
 * Listens for one conversational turn.
 * Returns a stop handle (finishes the turn early), or null if unsupported.
 */
export function startRecognition(
  handlers: RecognitionHandlers,
  opts: RecognitionOptions = {},
): (() => void) | null {
  return startTranscription(handlers, {
    silenceMs: opts.silenceMs,
    openingMs: opts.openingMs,
    maxTurnMs: opts.maxTurnMs,
    manualStop: opts.manualStop,
  });
}

export type ElevenVoice = { voice_id: string; name: string; description?: string };

/** The voices on the user's own ElevenLabs account, for the Profile picker. */
export async function listVoices(): Promise<ElevenVoice[]> {
  const key = (await getSecret("el_key"))?.trim();
  if (!key) throw new Error("Add your ElevenLabs key to choose a voice.");
  const resp = await fetch("https://api.elevenlabs.io/v1/voices", { headers: { "xi-api-key": key } });
  if (!resp.ok) throw new Error(`Couldn't load voices (${resp.status}).`);
  const data = (await resp.json()) as { voices?: { voice_id: string; name: string; labels?: Record<string, string> }[] };
  return (data.voices ?? []).map((v) => ({
    voice_id: v.voice_id,
    name: v.name,
    description: [v.labels?.accent, v.labels?.description].filter(Boolean).join(", ") || undefined,
  }));
}

/** Profile stores a voice id; older rows stored a display name, which is unusable. */
async function selectedVoiceId(): Promise<string> {
  try {
    const stored = ((await db.profiles.get("local"))?.voice ?? "").trim();
    return /^[A-Za-z0-9]{16,}$/.test(stored) ? stored : DEFAULT_VOICE_ID;
  } catch {
    return DEFAULT_VOICE_ID;
  }
}

let currentAudio: HTMLAudioElement | null = null;
let audioAbort: AbortController | null = null;

let unlockedCtx: AudioContext | null = null;
let unlockAttempted = false;

/**
 * Mobile autoplay unlock: call on the first mic tap. Creates/resumes an
 * AudioContext and plays a silent buffer so later ElevenLabs replies can
 * play on phones without being blocked.
 */
export async function ensureAudioUnlocked(): Promise<void> {
  try {
    if (typeof window === "undefined") return;
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    if (!unlockedCtx) {
      try {
        unlockedCtx = new AC();
      } catch {
        return;
      }
    }
    if (unlockedCtx.state === "suspended") {
      try {
        await unlockedCtx.resume();
      } catch {
        // Resume needs a gesture — the mic tap is that gesture; ignore failures.
      }
    }
    // Silent buffer: proves to the OS that this page plays audio on gesture.
    try {
      const len = Math.max(1, Math.floor(unlockedCtx.sampleRate * 0.05));
      const buf = unlockedCtx.createBuffer(1, len, unlockedCtx.sampleRate);
      const src = unlockedCtx.createBufferSource();
      src.buffer = buf;
      src.connect(unlockedCtx.destination);
      src.start();
    } catch {
      // Unlock is best-effort; playback errors still surface via speak().
    }
    unlockAttempted = true;
  } catch {
    // Never throw from unlock — speak() reports real failures.
  }
}

export function wasAudioUnlockAttempted(): boolean {
  return unlockAttempted;
}

/**
 * Split long replies into sentence-sized chunks for queued streaming TTS.
 * No truncation: every sentence is spoken in order.
 */
export function splitForSpeech(text: string, maxLen = 280): string[] {
  const clean = text.trim().replace(/\s+/g, " ");
  if (!clean) return [];
  if (clean.length <= maxLen) return [clean];
  const sentences = clean.match(/[^.!?]+[.!?]["')\]]?\s*|[^.!?]+$/g)?.map((s) => s.trim()).filter(Boolean) ?? [clean];
  const chunks: string[] = [];
  let current = "";
  for (const s of sentences) {
    if ((current + " " + s).trim().length <= maxLen) {
      current = (current + " " + s).trim();
    } else {
      if (current) chunks.push(current);
      if (s.length <= maxLen) {
        current = s;
      } else {
        // Very long sentence: hard-split on commas/clauses, then words.
        const parts = s.split(/(?<=[,;:—–-])\s+/);
        let piece = "";
        for (const p of parts) {
          if ((piece + " " + p).trim().length <= maxLen) piece = (piece + " " + p).trim();
          else {
            if (piece) chunks.push(piece);
            piece = p;
            while (piece.length > maxLen) {
              chunks.push(piece.slice(0, maxLen));
              piece = piece.slice(maxLen);
            }
          }
        }
        current = piece;
      }
    }
  }
  if (current) chunks.push(current);
  return chunks.filter(Boolean);
}

/**
 * Speak the first sentence on its own when a reply has several: a short
 * first request comes back sooner, and the rest is fetched while it plays.
 */
export function leadSentenceFirst(chunks: string[]): string[] {
  const first = chunks[0];
  if (!first || first.length < 120) return chunks;
  const m = first.match(/^(.{12,}?[.!?])\s+(\S.*)$/s);
  if (!m) return chunks;
  return [m[1], m[2], ...chunks.slice(1)];
}

function canUseMediaSource(): boolean {
  try {
    return typeof MediaSource !== "undefined" && MediaSource.isTypeSupported("audio/mpeg");
  } catch {
    return false;
  }
}

async function playBlob(blob: Blob, controller: AbortController): Promise<void> {
  let url: string | null = null;
  try {
    url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    currentAudio = audio;
    audio.preload = "auto";
    const release = () => {
      if (url) URL.revokeObjectURL(url);
      url = null;
      if (currentAudio === audio) currentAudio = null;
    };
    await new Promise<void>((resolve, reject) => {
      audio.onended = () => {
        release();
        resolve();
      };
      audio.onerror = () => {
        release();
        reject(new Error("Voice playback failed — text reply kept."));
      };
      const onAbort = () => {
        try {
          audio.pause();
          audio.currentTime = 0;
        } catch {}
        release();
        resolve();
      };
      if (controller.signal.aborted) {
        onAbort();
        return;
      }
      controller.signal.addEventListener("abort", onAbort, { once: true });
      const p = audio.play();
      if (p && typeof (p as Promise<void>).catch === "function") {
        (p as Promise<void>).catch((e) => {
          release();
          const name = (e as DOMException)?.name ?? "";
          if (name === "NotAllowedError" || name === "NotSupportedError") {
            reject(new Error("Playback was blocked by the browser — tap to allow audio. Text reply kept."));
          } else if (controller.signal.aborted) {
            resolve();
          } else {
            reject(new Error("Voice playback failed — text reply kept."));
          }
        });
      }
    });
  } finally {
    if (url) URL.revokeObjectURL(url);
  }
}

async function playStreamViaMediaSource(body: ReadableStream<Uint8Array>, controller: AbortController): Promise<void> {
  const mediaSource = new MediaSource();
  const url = URL.createObjectURL(mediaSource);
  const audio = new Audio(url);
  currentAudio = audio;
  const release = () => {
    try {
      URL.revokeObjectURL(url);
    } catch {}
    if (currentAudio === audio) currentAudio = null;
  };

  const opened = new Promise<void>((resolve, reject) => {
    mediaSource.addEventListener("sourceopen", () => resolve(), { once: true });
    mediaSource.addEventListener("sourceended", () => {}, { once: true });
    // If MediaSource never opens, fall back — don't hang the turn.
    setTimeout(() => reject(new Error("media-source-timeout")), 4000);
  });

  let playStarted = false;
  const ensurePlay = () => {
    if (playStarted) return;
    playStarted = true;
    const p = audio.play();
    if (p && typeof (p as Promise<void>).catch === "function") {
      (p as Promise<void>).catch(() => {
        // Surface as playback-blocked; caller keeps the text reply.
      });
    }
  };

  const done = new Promise<void>((resolve, reject) => {
    audio.onended = () => {
      release();
      resolve();
    };
    audio.onerror = () => {
      release();
      reject(new Error("Voice playback failed — text reply kept."));
    };
    const onAbort = () => {
      try {
        audio.pause();
      } catch {}
      try {
        if (mediaSource.readyState === "open") mediaSource.endOfStream();
      } catch {}
      release();
      resolve();
    };
    if (controller.signal.aborted) {
      onAbort();
      return;
    }
    controller.signal.addEventListener("abort", onAbort, { once: true });
  });

  try {
    await opened;
    const sb = mediaSource.addSourceBuffer("audio/mpeg");
    const reader = body.getReader();
    const queue: Uint8Array[] = [];
    let appending = false;
    let streamDone = false;
    let streamError: unknown = null;

    const pumpAppend = () => {
      if (appending) return;
      const next = queue.shift();
      if (!next) {
        if (streamDone && !appending) {
          try {
            if (mediaSource.readyState === "open") mediaSource.endOfStream();
          } catch {}
        }
        return;
      }
      appending = true;
      try {
        // Copy to ArrayBuffer: SourceBuffer needs a stable buffer.
        const copy = new Uint8Array(next).buffer as ArrayBuffer;
        sb.appendBuffer(copy);
      } catch (e) {
        streamError = e;
        appending = false;
        return;
      }
    };
    sb.addEventListener("updateend", () => {
      appending = false;
      ensurePlay();
      pumpAppend();
    });

    ensurePlay();
    for (;;) {
      if (controller.signal.aborted) break;
      const { done: rDone, value } = await reader.read();
      if (rDone) break;
      if (value && value.length) {
        queue.push(value);
        pumpAppend();
        // Start playback as audio arrives — don't wait for the full reply.
        ensurePlay();
      }
    }
    streamDone = true;
    pumpAppend();
    if (streamError) throw streamError;
    await done;
  } finally {
    release();
    try {
      if (mediaSource.readyState === "open") mediaSource.endOfStream();
    } catch {}
  }
}

function fetchTts(chunk: string, key: string, voiceId: string, controller: AbortController): Promise<Response> {
  return withNetRetry(
    () =>
      fetch(ttsStreamUrl(voiceId), {
        method: "POST",
        headers: { "xi-api-key": key, "Content-Type": "application/json" },
        body: JSON.stringify({ text: chunk, model_id: TTS_MODEL }),
        signal: controller.signal,
      }),
    { signal: controller.signal },
  );
}

async function speakOneChunk(chunk: string, key: string, voiceId: string, controller: AbortController, prefetched?: Promise<Response>): Promise<void> {
  const resp = await (prefetched ?? fetchTts(chunk, key, voiceId, controller));
  if (!resp.ok) {
    let detail = "";
    try {
      detail = (await resp.text()).slice(0, 200);
    } catch {}
    if (resp.status === 401 || resp.status === 403) {
      throw new Error("Voice key was rejected — check your ElevenLabs key in Profile → Voice. Text reply kept.");
    }
    throw new Error(`Voice failed (${resp.status})${detail ? ` — ${providerErrorText(detail)}` : ""}. Text reply kept.`);
  }
  const body = resp.body;
  // Prefer true streaming playback; fall back to full-blob where MediaSource
  // lacks audio/mpeg (e.g. some mobile browsers).
  if (body && canUseMediaSource()) {
    try {
      await playStreamViaMediaSource(body, controller);
      return;
    } catch (e) {
      if (controller.signal.aborted) return;
      // MediaSource path failed mid-stream — fall through to blob only if we
      // still have a body to re-read. The stream is consumed, so re-request
      // once as non-streaming rather than going silent.
      if ((e as Error)?.message === "media-source-timeout") {
        // Fall through to blob re-request below.
      } else {
        // Decode/playback errors must surface, not resolve silently.
        throw e instanceof Error ? e : new Error("Voice playback failed — text reply kept.");
      }
    }
  }
  // Full-blob fallback (also used when MediaSource never opened).
  // Re-request non-streaming if the stream body was already consumed.
  let blob: Blob;
  if (body && canUseMediaSource()) {
    const retry = await fetch(ttsStreamUrl(voiceId), {
      method: "POST",
      headers: { "xi-api-key": key, "Content-Type": "application/json" },
      body: JSON.stringify({ text: chunk, model_id: TTS_MODEL }),
      signal: controller.signal,
    });
    if (!retry.ok) throw new Error(`Voice failed (${retry.status}). Text reply kept.`);
    blob = await retry.blob();
  } else {
    blob = await resp.blob();
  }
  if (blob.size === 0) throw new Error("Voice returned no audio — text reply kept.");
  await playBlob(blob, controller);
}

export async function speak(rawText: string, opts?: { signal?: AbortSignal }): Promise<void> {
  if (!rawText.trim()) return;
  // Always the 12-hour clock out loud: "8 PM", never "20:00".
  const text = speakableTimes(rawText);

  const key = (await getSecret("el_key"))?.trim();
  if (!key) {
    throw new Error("Add your ElevenLabs key in Profile → Voice to hear replies. Text reply kept.");
  }
  if (!navigator.onLine) {
    throw new Error("You're offline — replies show as text until you're back online.");
  }

  const controller = new AbortController();
  audioAbort = controller;
  if (opts?.signal) {
    if (opts.signal.aborted) controller.abort();
    else opts.signal.addEventListener("abort", () => controller.abort(), { once: true });
  }

  try {
    const voiceId = await selectedVoiceId();
    const chunks = leadSentenceFirst(splitForSpeech(text));
    // The next chunk's audio is requested while the current one plays, so
    // there is no gap between sentences.
    let next: Promise<Response> | undefined = chunks.length ? fetchTts(chunks[0], key, voiceId, controller) : undefined;
    for (let i = 0; i < chunks.length; i += 1) {
      if (controller.signal.aborted) return;
      const current = next;
      next = i + 1 < chunks.length ? fetchTts(chunks[i + 1], key, voiceId, controller) : undefined;
      next?.catch(() => {}); // surfaced when (if) it's played
      await speakOneChunk(chunks[i], key, voiceId, controller, current);
    }
  } catch (error) {
    if ((error as DOMException)?.name === "AbortError") return;
    if (controller.signal.aborted || opts?.signal?.aborted) return;
    // Never fail silently — the caller shows this in the assistant panel.
    logFailure("voice reply", error);
    if (isNetworkError(error)) throw new Error(`${describeFailure("voice reply", error)} The text reply is kept.`);
    throw error instanceof Error ? error : new Error(String(error));
  } finally {
    if (audioAbort === controller) audioAbort = null;
  }
}

export function stopSpeaking() {
  try {
    audioAbort?.abort();
  } catch {}
  audioAbort = null;
  if (currentAudio) {
    try {
      currentAudio.pause();
      currentAudio.currentTime = 0;
    } catch {}
    currentAudio = null;
  }
}


/**
 * Watches the mic while the assistant is talking so the user can cut in.
 * Deliberately hard to trigger: it calibrates against the room, waits out the
 * first moment of playback, and needs sustained speech-level sound — otherwise
 * the assistant's own voice (or a keyboard) cuts it off mid-sentence.
 */
export function createBargeInAnalyser(onSpeech: () => void): (() => void) | null {
  if (!navigator.mediaDevices?.getUserMedia) return null;
  let stopped = false;
  let stream: MediaStream | null = null;
  let analyser: AnalyserNode | null = null;
  let raf = 0;
  let audioCtx: AudioContext | null = null;

  /** Ignore the first moment: speaker output needs time to settle into the AEC. */
  const GRACE_MS = 1200;
  /** Roughly a third of a second of continuous sound before we believe it. */
  const REQUIRED_FRAMES = 20;

  const startedAt = Date.now();

  navigator.mediaDevices
    .getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    })
    .then((s) => {
      if (stopped) {
        s.getTracks().forEach((t) => t.stop());
        return;
      }
      stream = s;
      audioCtx = new (window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
      const source = audioCtx.createMediaStreamSource(s);
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 512;
      source.connect(analyser);

      const data = new Uint8Array(analyser.frequencyBinCount);
      let loudFrames = 0;
      let noiseFloor = 0;
      let calibrationFrames = 0;

      const tick = () => {
        if (stopped || !analyser) return;
        analyser.getByteFrequencyData(data);
        const avg = data.reduce((a, b) => a + b, 0) / data.length;
        const elapsed = Date.now() - startedAt;

        // First half second: learn what this room plus this playback sounds like.
        if (elapsed < 500) {
          noiseFloor = (noiseFloor * calibrationFrames + avg) / (calibrationFrames + 1);
          calibrationFrames += 1;
          raf = requestAnimationFrame(tick);
          return;
        }

        const threshold = Math.max(42, noiseFloor * 2.4);
        if (elapsed > GRACE_MS && avg > threshold) loudFrames += 1;
        else loudFrames = Math.max(0, loudFrames - 2);

        if (loudFrames >= REQUIRED_FRAMES) {
          loudFrames = 0;
          onSpeech();
        }
        raf = requestAnimationFrame(tick);
      };
      tick();
    })
    .catch(() => {});

  return () => {
    stopped = true;
    cancelAnimationFrame(raf);
    if (stream) stream.getTracks().forEach((t) => t.stop());
    if (audioCtx) void audioCtx.close();
  };
}
