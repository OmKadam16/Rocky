import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The shared profile row (Supabase `extra` in the app): an in-memory stand-in.
const profile: Record<string, unknown> = {};
vi.mock("./db", () => ({
  db: {
    profiles: {
      get: async () => ({ id: "local", ...profile }),
      put: async (row: Record<string, unknown>) => {
        Object.assign(profile, row);
      },
    },
  },
}));

import { getSecret, secretPresence, setSecret, syncSecretsOnce } from "./secrets";

const KEY = "sk-test-ABCDEFGHIJKLMNOP1234";
const OTHER = "el-test-ZYXWVUT98765";

function fakeKeychain(start: Record<string, string> = {}) {
  const store = new Map(Object.entries(start));
  return {
    store,
    available: async () => true,
    get: async (n: string) => store.get(n) ?? null,
    set: async (n: string, v: string | null) => {
      if (v) store.set(n, v);
      else store.delete(n);
      return true;
    },
  };
}

const memStorage = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
};

let kc: ReturnType<typeof fakeKeychain>;
const g = globalThis as unknown as { window?: unknown };

beforeEach(() => {
  for (const k of Object.keys(profile)) delete profile[k];
  kc = fakeKeychain();
  g.window = { rocky: { isDesktop: true, platform: "win32", secrets: kc } };
});
afterEach(() => {
  delete g.window;
});

describe("secrets: one key per user, keychain as the desktop cache", () => {
  it("desktop setSecret writes the keychain AND the shared profile row", async () => {
    await setSecret("llm_key", KEY);
    expect(kc.store.get("llm_key")).toBe(KEY);
    expect(profile.llm_key_enc).toBe(KEY);
  });

  it("falls back to the shared copy when the keychain is empty, and caches it", async () => {
    profile.el_key_enc = OTHER;
    expect(await getSecret("el_key")).toBe(OTHER);
    expect(kc.store.get("el_key")).toBe(OTHER);
  });

  it("prefers the keychain when it has the key (no cloud round trip needed)", async () => {
    kc.store.set("llm_key", KEY);
    profile.llm_key_enc = null;
    expect(await getSecret("llm_key")).toBe(KEY);
  });

  it("wipe (setSecret null) clears both the keychain and the shared row", async () => {
    await setSecret("llm_key", KEY);
    await setSecret("llm_key", null);
    expect(kc.store.has("llm_key")).toBe(false);
    expect(profile.llm_key_enc).toBeNull();
    expect(await getSecret("llm_key")).toBeNull();
  });

  it("startup sync pushes keychain-only keys up once, and pulls newer shared ones", async () => {
    kc.store.set("llm_key", KEY);
    profile.el_key_enc = OTHER;
    const storage = memStorage();
    expect(await syncSecretsOnce(storage)).toBe(1);
    expect(profile.llm_key_enc).toBe(KEY);
    expect(kc.store.get("el_key")).toBe(OTHER);
    // Once only: a later wipe from elsewhere isn't undone by the next start.
    profile.llm_key_enc = null;
    expect(await syncSecretsOnce(storage)).toBe(0);
    expect(profile.llm_key_enc).toBeNull();
  });

  it("browser (no keychain) reads and writes the shared row only", async () => {
    delete g.window;
    await setSecret("browser_key", KEY);
    expect(profile.browser_key_enc).toBe(KEY);
    expect(await getSecret("browser_key")).toBe(KEY);
    expect(await syncSecretsOnce(memStorage())).toBe(0);
  });

  it("presence reports present/missing only, and key values never reach the console", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    await setSecret("llm_key", KEY);
    profile.el_key_enc = OTHER;
    await syncSecretsOnce(memStorage());
    const p = await secretPresence();
    expect(p).toEqual({ llm_key: true, el_key: true, browser_key: false });
    expect(JSON.stringify(p)).not.toContain(KEY);
    const printed = spies.flatMap((s) => s.mock.calls.flat().map(String)).join("\n");
    expect(printed).not.toContain(KEY);
    expect(printed).not.toContain(OTHER);
    spies.forEach((s) => s.mockRestore());
  });
});
