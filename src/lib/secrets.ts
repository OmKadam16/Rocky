import { db } from "./db";

/**
 * API keys. On desktop they live in the macOS Keychain via Electron's
 * safeStorage; in the browser they stay in Dexie, as before.
 *
 * Routing contract (two LLM keys, one voice key):
 * - `llm_key`: the planner — every voice/text turn, day analysis, voice check.
 * - `browser_key`: the browser worker — GPT-5.4 computer-use turns run by the
 *   future booking runner. Nothing reads it yet except the key test; the
 *   planner never touches it, so demo turns can't burn browser budget.
 * - `el_key`: ElevenLabs speech-to-text / text-to-speech only.
 */

type SecretName = "llm_key" | "el_key" | "browser_key";

type RockyBridge = {
  isDesktop: boolean;
  platform: string;
  secrets: {
    available: () => Promise<boolean>;
    get: (name: string) => Promise<string | null>;
    set: (name: string, value: string | null) => Promise<boolean>;
  };
};

const bridge = (): RockyBridge | null =>
  (typeof window !== "undefined" && (window as unknown as { rocky?: RockyBridge }).rocky) || null;

export const isDesktop = () => Boolean(bridge()?.isDesktop);

/** Dexie column backing each secret, used in the browser and for migration. */
const DEXIE_FIELD: Record<SecretName, "llm_key_enc" | "el_key_enc" | "browser_key_enc"> = {
  llm_key: "llm_key_enc",
  el_key: "el_key_enc",
  browser_key: "browser_key_enc",
};

export async function getSecret(name: SecretName): Promise<string | null> {
  const desktop = bridge();
  if (desktop && (await desktop.secrets.available())) {
    const stored = await desktop.secrets.get(name);
    if (stored) return stored;
    // First run after upgrading: lift the key out of Dexie into the keychain.
    const legacy = await readFromDexie(name);
    if (legacy) {
      await desktop.secrets.set(name, legacy);
      await writeToDexie(name, null);
      return legacy;
    }
    return null;
  }
  return readFromDexie(name);
}

export async function setSecret(name: SecretName, value: string | null): Promise<void> {
  const desktop = bridge();
  if (desktop && (await desktop.secrets.available())) {
    await desktop.secrets.set(name, value);
    await writeToDexie(name, null);
    return;
  }
  await writeToDexie(name, value);
}

async function readFromDexie(name: SecretName): Promise<string | null> {
  const profile = await db.profiles.get("local");
  const value = profile?.[DEXIE_FIELD[name]];
  return value?.trim() ? value.trim() : null;
}

async function writeToDexie(name: SecretName, value: string | null): Promise<void> {
  const profile = await db.profiles.get("local");
  if (!profile) return;
  await db.profiles.put({ ...profile, [DEXIE_FIELD[name]]: value });
}
