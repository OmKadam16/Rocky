// Desktop build with ELECTRON=1 (relative asset paths for app://rocky).
// A node script instead of `ELECTRON=1 tsc -b && …` so it also runs under
// Windows cmd, where npm scripts can't set env vars inline.
import { spawnSync } from "node:child_process";

const env = { ...process.env, ELECTRON: "1" };
for (const args of [["tsc", "-b"], ["vite", "build"]]) {
  const r = spawnSync("npx", args, { stdio: "inherit", env, shell: process.platform === "win32" });
  if (r.status !== 0) process.exit(r.status ?? 1);
}
