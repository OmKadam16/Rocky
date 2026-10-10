import { getSecret } from "./secrets";

/**
 * Voice input. Records one turn locally, waits out real pauses rather than
 * finalising at the first breath, and transcribes through ElevenLabs Scribe.
 *
 * ElevenLabs is the only provider in the conversation loop: Scribe listens,
 * ElevenLabs speaks. Chrome's Web Speech API used to sit in front of this on
 * the web build, but it never worked in Electron (Chromium ships there without
 * Google's speech keys) and gave two different turn-taking behaviours to
 * maintain. One path now, everywhere.
 */

const TRANSCRIBE_URL = "https://api.elevenlabs.io/v1/speech-to-text";
const TRANSCRIBE_MODEL = "scribe_v1";

export type TranscribeHandlers = {
  onPartial?: (text: string) => void;
  /** 0–1 mic level, so the UI can show something is being heard. */
  onLevel?: (level: number) => void;
  onSpeechStart?: () => void;
  onFinal: (text: string) => void;
  onError?: (message: string) => void;
  onEnd?: () => void;
};

export type TranscribeOptions = {
  silenceMs?: number;
  openingMs?: number;
  maxTurnMs?: number;
};

export function startTranscription(
  handlers: TranscribeHandlers,
  opts: TranscribeOptions = {},
): (() => void) | null {
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
    handlers.onError?.("No microphone available.");
    return null;
  }

  const silenceMs = opts.silenceMs ?? 1200;
  const openingMs = opts.openingMs ?? 15000;
  const maxTurnMs = opts.maxTurnMs ?? 90000;

  let finished = false;
  let heardSpeech = false;
  let recorder: MediaRecorder | null = null;
  let stream: MediaStream | null = null;
  let audioCtx: AudioContext | null = null;
  let raf = 0;
  let silenceTimer: ReturnType<typeof setTimeout> | null = null;
  const chunks: BlobPart[] = [];

  const openingTimer = setTimeout(() => {
    if (!heardSpeech) finish(false);
  }, openingMs);
  const maxTimer = setTimeout(() => finish(true), maxTurnMs);

  const teardown = () => {
    cancelAnimationFrame(raf);
    if (silenceTimer) clearTimeout(silenceTimer);
    clearTimeout(openingTimer);
    clearTimeout(maxTimer);
    if (audioCtx) void audioCtx.close();
    if (stream) stream.getTracks().forEach((t) => t.stop());
  };

  /** `transcribe` is false when nothing was ever said. `byUser` when the mic button ended the turn. */
  function finish(transcribe: boolean, byUser = false) {
    if (finished) return;
    finished = true;
    const shouldSend = transcribe && heardSpeech;

    if (recorder && recorder.state !== "inactive") {
      recorder.onstop = () => {
        teardown();
        if (shouldSend) void send(new Blob(chunks, { type: recorder?.mimeType || "audio/webm" }), byUser);
        else {
          handlers.onEnd?.();
        }
      };
      recorder.stop();
    } else {
      teardown();
      handlers.onEnd?.();
    }
  }

  function fileNameFor(blob: Blob): string {
    const mime = (blob.type || recorder?.mimeType || "").toLowerCase();
    if (mime.includes("mp4")) return "turn.mp4";
    if (mime.includes("ogg") || mime.includes("oga") || mime.includes("opus")) return "turn.ogg";
    return "turn.webm";
  }

  async function send(blob: Blob, byUser = false) {
    if (blob.size < 2000) {
      // Too short to be speech — don't spend a request on it. A deliberate
      // tap-off stays silent; anything else says so out loud.
      if (!byUser) handlers.onError?.("Didn't catch any audio — check the mic and try again.");
      handlers.onEnd?.();
      return;
    }
    try {
      const key = (await getSecret("el_key"))?.trim();
      if (!key) {
        handlers.onError?.("Add your ElevenLabs key in Profile → Voice to use voice.");
        handlers.onEnd?.();
        return;
      }
      const form = new FormData();
      form.append("file", blob, fileNameFor(blob));
      form.append("model_id", TRANSCRIBE_MODEL);
      form.append("language_code", (navigator.language || "en-US").slice(0, 2));

      const response = await fetch(TRANSCRIBE_URL, {
        method: "POST",
        headers: { "xi-api-key": key },
        body: form,
      });
      if (!response.ok) {
        const detail = await response.text();
        throw new Error(detail.slice(0, 140) || `transcription failed (${response.status})`);
      }
      const data = (await response.json()) as { text?: string };
      const text = (data.text ?? "").trim();
      if (text) handlers.onFinal(text);
    } catch (error) {
      handlers.onError?.(error instanceof Error ? error.message : String(error));
    } finally {
      handlers.onEnd?.();
    }
  }

  navigator.mediaDevices
    .getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    })
    .then((granted) => {
      if (finished) {
        granted.getTracks().forEach((t) => t.stop());
        return;
      }
      stream = granted;
      recorder = new MediaRecorder(granted);
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunks.push(event.data);
      };
      recorder.start(250);

      // Same end-of-turn behaviour as the Web Speech path: a pause only ends
      // the turn after a real silence, and only once you've actually spoken.
      audioCtx = new (window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 512;
      audioCtx.createMediaStreamSource(granted).connect(analyser);

      const data = new Uint8Array(analyser.frequencyBinCount);
      let noiseFloor = 0;
      let calibrationFrames = 0;
      const startedAt = Date.now();

      const tick = () => {
        if (finished) return;
        analyser.getByteFrequencyData(data);
        const avg = data.reduce((a, b) => a + b, 0) / data.length;

        if (Date.now() - startedAt < 400) {
          noiseFloor = (noiseFloor * calibrationFrames + avg) / (calibrationFrames + 1);
          calibrationFrames += 1;
          raf = requestAnimationFrame(tick);
          return;
        }

        handlers.onLevel?.(Math.min(1, avg / 90));
        const speaking = avg > Math.max(18, noiseFloor * 1.8);
        if (speaking) {
          if (!heardSpeech) {
            heardSpeech = true;
            clearTimeout(openingTimer);
            handlers.onSpeechStart?.();
          }
          if (silenceTimer) clearTimeout(silenceTimer);
          silenceTimer = setTimeout(() => finish(true), silenceMs);
        }
        raf = requestAnimationFrame(tick);
      };
      tick();
    })
    .catch(() => {
      finished = true;
      teardown();
      handlers.onError?.("Microphone access was blocked.");
      handlers.onEnd?.();
    });

  // Mic-button stop: the user ended the turn on purpose.
  return () => finish(true, true);
}
