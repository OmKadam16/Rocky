import { describe, expect, it } from "vitest";
import { secureAuthStorage } from "./native";

/**
 * A stand-in for a Capacitor plugin: like registerPlugin's Proxy, EVERY
 * property is a native method, `then` included (Capacitor only special-cases
 * $$typeof, toJSON and addListener). A native "then" never calls resolve.
 */
function capacitorLikePlugin(store: Map<string, string>) {
  const methods: Record<string, (...a: never[]) => Promise<unknown>> = {
    getItem: async (key: string) => store.get(key) ?? null,
    setItem: async (key: string, value: string) => void store.set(key, value),
    removeItem: async (key: string) => void store.delete(key),
  };
  return new Proxy({}, {
    get(_, prop) {
      if (prop === "$$typeof") return undefined;
      if (prop === "toJSON") return () => ({});
      const fn = methods[String(prop)];
      return fn ?? (() => {
        // Like Capacitor: an unknown method rejects (nobody is listening).
        const p = Promise.reject(new Error(`"${String(prop)}" is not implemented on android`));
        p.catch(() => {});
        return p;
      });
    },
  }) as { getItem(k: string): Promise<string | null>; setItem(k: string, v: string): Promise<void>; removeItem(k: string): Promise<void> };
}

const settlesWithin = <T,>(p: Promise<T>, ms = 200) =>
  Promise.race([p.then((v) => ({ settled: true as const, v })), new Promise<{ settled: false }>((r) => setTimeout(() => r({ settled: false }), ms))]);

describe("secureAuthStorage (Android session storage)", () => {
  it("reproduces the boot hang: a promise resolved WITH a plugin never settles", async () => {
    const plugin = capacitorLikePlugin(new Map());
    // The old code: import(...).then((m) => m.SecureStorage)
    const old = Promise.resolve({ SecureStorage: plugin }).then((m) => m.SecureStorage);
    const r = await settlesWithin(old);
    expect(r.settled).toBe(false);
  });

  it("reads, writes and removes through the plugin and always settles", async () => {
    const store = new Map<string, string>();
    const plugin = capacitorLikePlugin(store);
    const s = secureAuthStorage(async () => ({ SecureStorage: plugin }));
    expect(await settlesWithin(s.getItem("sb-auth"))).toEqual({ settled: true, v: null });
    await s.setItem("sb-auth", "{\"a\":1}");
    expect(store.get("sb-auth")).toBe("{\"a\":1}");
    expect(await settlesWithin(s.getItem("sb-auth"))).toEqual({ settled: true, v: "{\"a\":1}" });
    await s.removeItem("sb-auth");
    expect(store.has("sb-auth")).toBe(false);
  });
});
