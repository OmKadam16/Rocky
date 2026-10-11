"use strict";
/**
 * ElevenLabs speech-to-text through the main process.
 *
 * Renderer uploads of full mic turns were dying at the network level while
 * tiny probes to the same host succeeded, so transcription no longer goes
 * through the renderer fetch stack on desktop: the renderer records audio as
 * before and hands the bytes over IPC, and Node posts the multipart upload.
 * Same endpoint, same key, same messages back — only the stack changes.
 * Browsers (no bridge) keep the direct fetch path in src/lib/transcribe.ts.
 */

const ELEVEN_STT = "https://api.elevenlabs.io/v1/speech-to-text";
/** 90-second turns never approach this; anything bigger is a corrupt blob. */
const MAX_AUDIO_BYTES = 15 * 1024 * 1024;

function asBytes(audio) {
  if (audio instanceof Uint8Array) return audio;
  if (Array.isArray(audio)) return Uint8Array.from(audio);
  return new Uint8Array(0);
}

/**
 * Post one turn for transcription. Throws the same shapes the renderer path
 * threw, so callers keep their retry + message behaviour unchanged:
 * network-level failure -> "Failed to fetch ..." (retried), HTTP error ->
 * the provider's detail text (surfaced).
 */
async function postTranscribe(fetchImpl, args) {
  const a = (args && typeof args === "object") ? args : {};
  const key = String(a.key || "").trim();
  if (!key) throw new Error("Add your ElevenLabs key in Profile → Voice to use voice.");
  const bytes = asBytes(a.audio);
  if (bytes.length === 0) throw new Error("No audio to transcribe.");
  if (bytes.length > MAX_AUDIO_BYTES) throw new Error("That recording is too long — try a shorter turn.");
  const form = new FormData();
  form.append("file", new Blob([bytes], { type: String(a.mime || "audio/webm") }), String(a.fileName || "turn.webm"));
  form.append("model_id", "scribe_v1");
  if (a.language) form.append("language_code", String(a.language));
  let resp;
  try {
    resp = await fetchImpl(ELEVEN_STT, {
      method: "POST",
      headers: { "xi-api-key": key },
      body: form,
    });
  } catch (e) {
    throw new Error(`Failed to fetch ${ELEVEN_STT} (${e && e.message ? e.message : e})`);
  }
  if (!resp.ok) {
    let detail = "";
    try {
      detail = await resp.text();
    } catch {
      /* fall through to status */
    }
    throw new Error(String(detail || "").slice(0, 140) || `transcription failed (${resp.status})`);
  }
  const data = await resp.json();
  return String((data && data.text) || "").trim();
}

function registerVoiceProxy(ipcMain, fetchImpl) {
  ipcMain.handle("voice:transcribe", (_event, args) => postTranscribe(fetchImpl, args));
}

module.exports = { registerVoiceProxy, postTranscribe, MAX_AUDIO_BYTES, ELEVEN_STT };
