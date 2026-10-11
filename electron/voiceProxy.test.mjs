// Main-process STT proxy: same endpoint/key/messages as the renderer path,
// only the network stack changes. No network, no Electron: fetch is faked.
import { describe, expect, it } from "vitest";
import proxy from "./voiceProxy.cjs";

const { registerVoiceProxy, postTranscribe, MAX_AUDIO_BYTES } = proxy;

const okFetch = (text) => async (url, opts) => {
  okFetch.last = { url, opts };
  return { ok: true, json: async () => ({ text }) };
};

function fakeIpc() {
  const handlers = {};
  return { handlers, handle: (name, fn) => { handlers[name] = fn; } };
}

describe("voice proxy registration", () => {
  it("exposes voice:transcribe over IPC", async () => {
    const ipc = fakeIpc();
    registerVoiceProxy(ipc, okFetch("hello there"));
    expect(typeof ipc.handlers["voice:transcribe"]).toBe("function");
    const text = await ipc.handlers["voice:transcribe"]({}, { key: "sk_test", audio: new Uint8Array([1, 2, 3]) });
    expect(text).toBe("hello there");
    expect(okFetch.last.url).toBe("https://api.elevenlabs.io/v1/speech-to-text");
    expect(okFetch.last.opts.method).toBe("POST");
    expect(okFetch.last.opts.headers).toMatchObject({ "xi-api-key": "sk_test" });
    expect(okFetch.last.opts.body).toBeInstanceOf(FormData);
  });
});

describe("postTranscribe", () => {
  it("trims provider text and defaults the file shape", async () => {
    const seen = {};
    const text = await postTranscribe(async (url, opts) => {
      seen.url = url;
      seen.parts = [...opts.body.entries()].map(([k, v]) => [k, typeof v === "string" ? v : `${v.constructor.name}:${v.size}`]);
      return { ok: true, json: async () => ({ text: "  dinner at seven  " }) };
    }, { key: "sk_test", audio: new Uint8Array([9]), mime: "audio/webm", fileName: "turn.webm", language: "en" });
    expect(text).toBe("dinner at seven");
    expect(seen.url).toBe("https://api.elevenlabs.io/v1/speech-to-text");
    expect(seen.parts).toContainEqual(["model_id", "scribe_v1"]);
    expect(seen.parts).toContainEqual(["language_code", "en"]);
  });

  it("rejects empty keys, empty audio and absurd uploads before any fetch", async () => {
    let called = false;
    const never = async () => { called = true; return { ok: true, json: async () => ({}) }; };
    await expect(postTranscribe(never, { key: "  ", audio: new Uint8Array([1]) })).rejects.toThrow(/ElevenLabs key/);
    await expect(postTranscribe(never, { key: "sk_test", audio: new Uint8Array(0) })).rejects.toThrow(/No audio/);
    await expect(postTranscribe(never, { key: "sk_test", audio: new Uint8Array(MAX_AUDIO_BYTES + 1) })).rejects.toThrow(/too long/);
    expect(called).toBe(false);
  });

  it("surfaces provider detail on HTTP errors (401 reads like a key problem, not a drop)", async () => {
    await expect(postTranscribe(async () => ({ ok: false, status: 401, text: async () => "Unauthorized" }), {
      key: "sk_dead", audio: new Uint8Array([1]),
    })).rejects.toThrow("Unauthorized");
    await expect(postTranscribe(async () => ({ ok: false, status: 500, text: async () => "" }), {
      key: "sk_test", audio: new Uint8Array([1]),
    })).rejects.toThrow(/transcription failed \(500\)/);
  });

  it("maps network failure to Failed-to-fetch so the renderer retries it", async () => {
    await expect(postTranscribe(async () => { throw new TypeError("fetch failed"); }, {
      key: "sk_test", audio: new Uint8Array([1]),
    })).rejects.toThrow(/Failed to fetch https:\/\/api\.elevenlabs\.io/);
  });
});
