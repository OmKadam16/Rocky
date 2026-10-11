/**
 * "Spoken progress updates" (Profile → Voice), on by default. Lives in the
 * profile row's `extra` column (`progress_speech`), so it follows the user to
 * every device. No migration. Cached so the voice loop never waits on it.
 */
import { db } from "./db";

let cached: boolean | null = null;

export const progressSpeechOn = () => cached ?? true;

export async function loadProgressSpeech(): Promise<boolean> {
  try {
    const p = (await db.profiles.get("local")) as unknown as { progress_speech?: boolean } | undefined;
    cached = p?.progress_speech !== false;
  } catch {
    /* keep the default */
  }
  return progressSpeechOn();
}

export async function setProgressSpeech(on: boolean): Promise<void> {
  cached = on;
  const p = ((await db.profiles.get("local")) ?? { id: "local" }) as unknown as Record<string, unknown>;
  await db.profiles.put({ ...p, id: "local", progress_speech: on } as never);
}
