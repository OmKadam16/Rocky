// Builds the Rocky Memory Chrome extension: extension/src -> extension/dist
// (load it via chrome://extensions -> Developer mode -> Load unpacked).
// Plain JS, no bundler. Fails if the manifest key doesn't give the extension
// ID the Memory server trusts (electron/memoryServer.cjs EXTENSION_ID).
import { createHash } from "node:crypto";
import { copyFileSync, cpSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "extension", "src");
const dist = join(root, "extension", "dist");

export function extensionIdFromKey(key) {
  const der = Buffer.from(key, "base64");
  return createHash("sha256")
    .update(der)
    .digest("hex")
    .slice(0, 32)
    .split("")
    .map((h) => String.fromCharCode(97 + parseInt(h, 16)))
    .join("");
}

const manifest = JSON.parse(readFileSync(join(src, "manifest.json"), "utf8"));
const { EXTENSION_ID } = createRequire(import.meta.url)(join(root, "electron", "memoryServer.cjs"));
const id = extensionIdFromKey(manifest.key);
if (id !== EXTENSION_ID) {
  console.error(`Extension ID ${id} doesn't match memoryServer EXTENSION_ID ${EXTENSION_ID}.`);
  process.exit(1);
}

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });
cpSync(src, dist, { recursive: true, filter: (p) => !p.endsWith(".test.mjs") });
copyFileSync(join(root, "build", "icon.png"), join(dist, "icon.png"));
console.log(`Rocky Memory extension built -> extension/dist (id ${id})`);
