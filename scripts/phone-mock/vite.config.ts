/**
 * Vite config for the phone screenshot harness (scripts/phone-screens.mjs):
 * the real app, with src/lib/supabase.ts and src/lib/chatHistory.ts swapped
 * for local fakes so /remote renders signed in and paired without a network.
 */
import { defineConfig, mergeConfig, type Plugin } from "vite";
import path from "node:path";
import base from "../../vite.config";

const root = path.resolve(__dirname, "../..");
const SWAP: Record<string, string> = {
  [path.join(root, "src", "lib", "supabase.ts")]: path.join(__dirname, "supabase.ts"),
  [path.join(root, "src", "lib", "chatHistory.ts")]: path.join(__dirname, "chatHistory.ts"),
};

const swap: Plugin = {
  name: "rocky-phone-mock",
  enforce: "pre",
  async resolveId(source, importer, options) {
    if (!importer || importer.includes("phone-mock")) return null;
    const r = await this.resolve(source, importer, { ...options, skipSelf: true });
    if (!r) return null;
    const hit = SWAP[path.normalize(r.id.split("?")[0])];
    return hit ?? null;
  },
};

export default mergeConfig(base, defineConfig({ root, plugins: [swap], server: { port: 5199, strictPort: true } }));
