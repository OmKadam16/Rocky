import { db } from "./db";

/**
 * API keys: one key per user, shared by all their devices (AGENTS.md rule 5).
 *
 * The shared copy lives on the user's profile row (`extra` on Supabase, RLS
 * "own rows only"; Dexie when Rocky runs without Supabase). On desktop the OS
 * keychain (Electron safeStorage) is a fast local cache in front of it:
 * - setSecret writes both, so a key typed on the laptop reaches the phone;
 * - getSecret reads the keychain first and falls back to the shared copy;
 * - syncSecretsOnce() (startup, once per device) pushes keys that only exist
 *   in the keychain up to the profile row and refreshes the cache from it.
 * Key values are never logged.
 *
 * Routing contract (two LLM keys, one voice key):
 * - `llm_key`: the planner — every voice/text turn, day analysis, voice check.
 * - `browser_key`: the browser worker — GPT-5.4 computer-use turns.
 * - `el_key`: ElevenLabs speech-to-text / text-to-speech only.
 */

export type SecretName = "llm_key" | "el_key" | "browser_key";
export const SECRET_NAMES: readonly SecretName[] = ["llm_key", "el_key", "browser_key"];

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

/** Profile field backing each secret (synced through `extra` on Supabase). */
const PROFILE_FIELD: Record<SecretName, "llm_key_enc" | "el_key_enc" | "browser_key_enc"> = {
  llm_key: "llm_key_enc",
  el_key: "el_key_enc",
  browser_key: "browser_key_enc",
};

async function keychain(): Promise<RockyBridge["secrets"] | null> {
  const desktop = bridge();
  if (!desktop) return null;
  try {
    return (await desktop.secrets.available()) ? desktop.secrets : null;
  } catch {
    return null;
  }
}

export async function getSecret(name: SecretName): Promise<string | null> {
  const kc = await keychain();
  if (kc) {
    const stored = await kc.get(name).catch(() => null);
    if (stored) return stored;
    // Keychain empty (new laptop, or the key was typed on the phone): use the
    // shared copy and cache it locally.
    const shared = await readShared(name).catch(() => null);
    if (shared) await kc.set(name, shared).catch(() => false);
    return shared;
  }
  return readShared(name);
}

export async function setSecret(name: SecretName, value: string | null): Promise<void> {
  const clean = value?.trim() ? value.trim() : null;
  const kc = await keychain();
  if (kc) await kc.set(name, clean);
  // Always the shared copy too, so every device of this user gets the same key
  // (and a wipe clears it everywhere).
  await writeShared(name, clean);
}

/** Which keys exist (never their values) — for the phone connection check. */
export async function secretPresence(): Promise<Record<SecretName, boolean>> {
  const out = {} as Record<SecretName, boolean>;
  for (const n of SECRET_NAMES) out[n] = Boolean(await getSecret(n).catch(() => null));
  return out;
}

const SYNC_FLAG = "rocky-keys-synced-v1";

/**
 * Desktop startup, once per device: keys that only exist in the keychain (set
 * by an older build that never shared them) go up to the profile row; shared
 * keys that differ from the cache refresh it. Returns how many were pushed.
 * Runs only once per device so a later "wipe everywhere" isn't undone.
 */
export async function syncSecretsOnce(storage: Pick<Storage, "getItem" | "setItem"> | null = safeStorage()): Promise<number> {
  const kc = await keychain();
  if (!kc) return 0;
  if (storage?.getItem(SYNC_FLAG) === "1") return 0;
  let pushed = 0;
  for (const name of SECRET_NAMES) {
    const local = await kc.get(name).catch(() => null);
    const shared = await readShared(name);
    if (local && !shared) {
      await writeShared(name, local);
      pushed += 1;
    } else if (shared && shared !== local) {
      await kc.set(name, shared).catch(() => false);
    }
  }
  storage?.setItem(SYNC_FLAG, "1");
  return pushed;
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage !== "undefined" ? localStorage : null;
  } catch {
    return null;
  }
}

async function readShared(name: SecretName): Promise<string | null> {
  const profile = await db.profiles.get("local");
  const value = profile?.[PROFILE_FIELD[name]];
  return value?.trim() ? value.trim() : null;
}

async function writeShared(name: SecretName, value: string | null): Promise<void> {
  const profile = await db.profiles.get("local");
  if (!profile) return;
  await db.profiles.put({ ...profile, [PROFILE_FIELD[name]]: value });
}
