// Desktop build with ELECTRON=1 (relative asset paths for app://rocky).
// A node script instead of `ELECTRON=1 tsc -b && …` so it also runs under
// Windows cmd, where npm scripts can't set env vars inline.
import { spawnSync } from "node:child_process";
import { loadEnv } from "vite";
import { banner, checkPublicUrl } from "./publicUrlGuard.mjs";

// The phone address the Devices screen shows (see publicUrlGuard.mjs).
const fileEnv = loadEnv("production", process.cwd(), "VITE_");
const guard = checkPublicUrl(process.env.VITE_PUBLIC_URL ?? fileEnv.VITE_PUBLIC_URL, { strict: process.env.ROCKY_REQUIRE_PUBLIC_URL === "1" });
if (guard.level === "ok") console.log(`[rocky] ${guard.message}`);
else console.warn(banner(guard.level, guard.message));
if (guard.level === "error") process.exit(1);

const env = { ...process.env, ELECTRON: "1" };
for (const args of [["tsc", "-b"], ["vite", "build"]]) {
  const r = spawnSync("npx", args, { stdio: "inherit", env, shell: process.platform === "win32" });
  if (r.status !== 0) process.exit(r.status ?? 1);
}
