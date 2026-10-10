import OpenAI from "openai";
import { PROVIDER_BASE_URL, normalizeProvider, resolveModelId } from "./models";

function plainError(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  // Strip SDK noise, keep provider's words.
  return m.replace(/^.*?(401|403|404|429|400)\s*/s, "$1 ").slice(0, 220).trim() || "Request failed.";
}

/** One tiny chat request that works for the chosen model. Tries max_tokens, falls back to max_completion_tokens. */
export async function testLlmKey(providerRaw: string, modelRaw: string, apiKey: string): Promise<{ ok: boolean; message: string }> {
  const provider = normalizeProvider(providerRaw);
  const model = resolveModelId(modelRaw, provider);
  const key = apiKey.trim();
  if (!key) return { ok: false, message: "Paste a key first." };
  const baseURL = PROVIDER_BASE_URL[provider];
  const mk = () =>
    new OpenAI({
      apiKey: key,
      baseURL,
      dangerouslyAllowBrowser: true,
      defaultHeaders: provider === "Anthropic" ? { "anthropic-dangerous-direct-browser-access": "true" } : undefined,
    });
  const body = (extra: Record<string, unknown>) => ({
    model,
    messages: [{ role: "user" as const, content: "hi" }],
    ...extra,
  });
  try {
    const client = mk();
    try {
      await client.chat.completions.create(body({ max_tokens: 1 }) as never);
      return { ok: true, message: "Connected." };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/max_tokens|max_completion_tokens|unsupported.*token/i.test(msg)) {
        const client2 = mk();
        await client2.chat.completions.create(body({ max_completion_tokens: 4 }) as never);
        return { ok: true, message: "Connected." };
      }
      throw e;
    }
  } catch (e) {
    return { ok: false, message: plainError(e) };
  }
}

function silentWavBlob(): Blob {
  // 0.5s 16kHz mono 16-bit silence — just enough to exercise the STT endpoint.
  const rate = 16000;
  const len = Math.floor(rate * 0.5);
  const buf = new ArrayBuffer(44 + len * 2);
  const v = new DataView(buf);
  const wstr = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i));
  };
  wstr(0, "RIFF");
  v.setUint32(4, 36 + len * 2, true);
  wstr(8, "WAVE");
  wstr(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  wstr(36, "data");
  v.setUint32(40, len * 2, true);
  return new Blob([buf], { type: "audio/wav" });
}

/**
 * ElevenLabs key test must confirm STT + TTS, not just account access.
 * Returns which permission is missing in plain words.
 */
export async function testElevenKey(apiKey: string): Promise<{ ok: boolean; message: string; tts: boolean; stt: boolean }> {
  const key = apiKey.trim();
  if (!key) return { ok: false, message: "Paste a key first.", tts: false, stt: false };
  let tts = false;
  let stt = false;
  let ttsErr = "";
  let sttErr = "";
  // TTS: tiny synthesis with the default voice.
  try {
    const resp = await fetch("https://api.elevenlabs.io/v1/text-to-speech/EXAVITQu4vr4xnSDxMaL", {
      method: "POST",
      headers: { "xi-api-key": key, "Content-Type": "application/json" },
      body: JSON.stringify({ text: "hi", model_id: "eleven_flash_v2_5" }),
    });
    if (resp.ok) {
      const b = await resp.blob();
      tts = b.size > 0;
      if (!tts) ttsErr = "TTS returned no audio.";
    } else {
      const t = (await resp.text().catch(() => "")).slice(0, 200);
      ttsErr = resp.status === 401 || resp.status === 403 ? `TTS permission missing (${resp.status}). ${t}`.slice(0, 220) : `TTS failed (${resp.status}). ${t}`.slice(0, 220);
    }
  } catch (e) {
    ttsErr = e instanceof Error ? e.message.slice(0, 200) : String(e).slice(0, 200);
  }
  // STT: tiny silent wav to Scribe. 422/format errors still prove the key reaches STT.
  try {
    const form = new FormData();
    form.append("file", silentWavBlob(), "test.wav");
    form.append("model_id", "scribe_v1");
    const resp = await fetch("https://api.elevenlabs.io/v1/speech-to-text", {
      method: "POST",
      headers: { "xi-api-key": key },
      body: form,
    });
    if (resp.ok) {
      stt = true;
    } else {
      const t = (await resp.text().catch(() => "")).slice(0, 200);
      if (resp.status === 401 || resp.status === 403) {
        sttErr = `STT permission missing (${resp.status}). ${t}`.slice(0, 220);
      } else if (resp.status === 422 || /audio|format|speech/i.test(t)) {
        // Key is valid and reached STT; our silence just has no speech.
        stt = true;
      } else {
        sttErr = `STT failed (${resp.status}). ${t}`.slice(0, 220);
      }
    }
  } catch (e) {
    sttErr = e instanceof Error ? e.message.slice(0, 200) : String(e).slice(0, 200);
  }
  if (tts && stt) return { ok: true, message: "Connected — voice in and out work.", tts, stt };
  const missing = [!tts ? `TTS${ttsErr ? `: ${ttsErr}` : ""}` : null, !stt ? `STT${sttErr ? `: ${sttErr}` : ""}` : null].filter(Boolean).join(" ");
  return { ok: false, message: missing.slice(0, 280) || "Key check failed.", tts, stt };
}
