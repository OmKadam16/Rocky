import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// The desktop build is served from app://rocky, so assets must be relative.
const base = process.env.ELECTRON ? "./" : process.env.GITHUB_ACTIONS ? "/Rocky/" : "/";

export default defineConfig({
  base,
  plugins: [react(), tailwindcss()],
  server: {
    port: process.env.PORT ? Number(process.env.PORT) : 8080,
    // The installer build writes (and locks) files here; watching them
    // crashed a running dev server with EBUSY.
    watch: { ignored: ["**/release/**", "**/dist-electron/**"] },
  },
});
