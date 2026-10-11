// Rocky Memory extension: pure helpers + manifest/permission rules.
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { DEFAULT_EXCLUDED, EXCLUDED_WORDS, QUEUE_MAX, cleanText, enqueue, originPattern, seenRecently, shouldCapture } from "./src/lib.js";
import storeMod from "../electron/memoryStore.cjs";
import serverMod from "../electron/memoryServer.cjs";

const dir = import.meta.dirname;
const manifest = JSON.parse(fs.readFileSync(path.join(dir, "src", "manifest.json"), "utf8"));

describe("what the extension captures", () => {
  it("same default exclusions as the app's store", () => {
    expect(DEFAULT_EXCLUDED).toEqual(storeMod.DEFAULT_EXCLUDED);
    expect(EXCLUDED_WORDS.source).toBe(storeMod.EXCLUDED_WORDS.source);
  });

  it("ordinary pages yes; banking, email, health, password managers, the user's list and non-web no", () => {
    expect(shouldCapture("https://en.wikipedia.org/wiki/CRISPR")).toBe(true);
    for (const u of ["https://mail.google.com/x", "https://www.chase.com/", "https://online.mybank.example", "https://mychart.example.org", "https://vault.bitwarden.com", "chrome://settings", "file:///C:/x.html", "http://127.0.0.1:47821/"]) {
      expect(shouldCapture(u), u).toBe(false);
    }
    expect(shouldCapture("https://news.ycombinator.com/item?id=1", ["ycombinator.com"])).toBe(false);
  });

  it("offline queue is small and drops screenshots; dedupe window", () => {
    let q = [];
    for (let i = 0; i < QUEUE_MAX + 5; i += 1) q = enqueue(q, { url: `https://a.example/${i}`, title: "t", text: "x", screenshot: "data:image/jpeg;base64,AAAA" });
    expect(q).toHaveLength(QUEUE_MAX);
    expect(q[0].url).toBe("https://a.example/5");
    expect(q.some((i) => "screenshot" in i)).toBe(false);
    const now = Date.now();
    expect(seenRecently({ k: now - 1000 }, "k", now).seen).toBe(true);
    expect(seenRecently({ k: now - 7 * 3600 * 1000 }, "k", now)).toEqual({ seen: false, recent: {} });
    expect(cleanText("a  \n\n\n\n b").length).toBeLessThan(10);
    expect(originPattern("https://www.example.com/a?b")).toBe("https://www.example.com/*");
  });
});

describe("minimal permissions", () => {
  it("no all-urls permission, no content scripts, no incognito", () => {
    expect(manifest.permissions.sort()).toEqual(["activeTab", "alarms", "scripting", "storage"]);
    expect(manifest.host_permissions).toEqual(["http://127.0.0.1/*"]);
    expect(manifest).not.toHaveProperty("content_scripts");
    expect(JSON.stringify(manifest.permissions)).not.toMatch(/all_urls/);
    expect(manifest.incognito).toBe("not_allowed");
    // Automatic capture is opt-in at runtime (popup asks; Chrome prompts).
    expect(manifest.optional_host_permissions).toEqual(["https://*/*", "http://*/*"]);
  });

  it("its ID (from the public key) is the one the Memory server trusts", () => {
    const id = createHash("sha256").update(Buffer.from(manifest.key, "base64")).digest("hex").slice(0, 32).split("").map((h) => String.fromCharCode(97 + parseInt(h, 16))).join("");
    expect(id).toBe(serverMod.EXTENSION_ID);
    expect(manifest.key).not.toMatch(/PRIVATE/);
  });

  it("only ever talks to 127.0.0.1", () => {
    for (const f of ["background.js", "popup.js", "lib.js", "extract.js"]) {
      const s = fs.readFileSync(path.join(dir, "src", f), "utf8");
      for (const u of s.match(/https?:\/\/[^\s"'`)]+/g) ?? []) {
        expect(u, `${f}: ${u}`).toMatch(/^http:\/\/127\.0\.0\.1|^https?:\/\/\*\/\*$|^https?:\/\/\$\{|^https?:\/\/[a-z.]*example\b/);
      }
      expect(s).not.toMatch(/console\.(log|info|debug)/);
    }
  });
});

describe("time on page", () => {
  it("counts seconds of a reading segment, ignores blips, caps at 4 hours", async () => {
    const { visitSeconds } = await import("./src/lib.js");
    expect(visitSeconds(0, 2000)).toBe(0);
    expect(visitSeconds(0, 95_000)).toBe(95);
    expect(visitSeconds(0, 10 * 3600 * 1000)).toBe(4 * 3600);
    expect(visitSeconds("bad", 5000)).toBe(0);
  });
});
