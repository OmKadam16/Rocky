/**
 * Renderer side of the main-process transcription proxy.
 *
 * `window.rocky.voice` exists only in the desktop app (see
 * electron/preload.cjs). Everywhere else these helpers report unavailable and
 * callers keep their direct-fetch path unchanged.
 */

export type VoiceBridge = {
  transcribe: (args: {
    key: string;
    audio: Uint8Array;
    mime: string;
    fileName: string;
    language: string;
  }) => Promise<string>;
};

const bridge = (): VoiceBridge | null => {
  try {
    const w = window as unknown as { rocky?: { voice?: VoiceBridge } };
    return w.rocky?.voice ?? null;
  } catch {
    return null;
  }
};

/** True only on desktop, where transcription runs in main. */
export function voiceProxyAvailable(): boolean {
  return bridge() !== null;
}

export function proxyTranscribe(args: {
  key: string;
  audio: Uint8Array;
  mime: string;
  fileName: string;
  language: string;
}): Promise<string> {
  const b = bridge();
  if (!b) throw new Error("Voice proxy unavailable in this browser.");
  return b.transcribe(args);
}
