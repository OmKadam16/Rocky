import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { readFileSync } from "node:fs";

// The desktop build is served from app://rocky, so assets must be relative.
// The Android build (CAPACITOR=1) is served from https://localhost/ and its
// over-the-air bundles from the updater's own root: absolute "/" for both.
const base = process.env.ELECTRON ? "./" : process.env.CAPACITOR ? "/" : process.env.GITHUB_ACTIONS ? "/Rocky/" : "/";
const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as { version: string };

export default defineConfig({
  base,
  plugins: [react(), tailwindcss()],
  // One version for everything: package.json -> the web bundle (here),
  // Android versionName/versionCode (android/app/build.gradle), the desktop app.
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  server: {
    port: process.env.PORT ? Number(process.env.PORT) : 8080,
    // The installer build writes (and locks) files here; watching them
    // crashed a running dev server with EBUSY.
    watch: { ignored: ["**/release/**", "**/dist-electron/**"] },
  },
});
