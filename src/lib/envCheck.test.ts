import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { envValueProblem, firstEnvProblem } from "../../shared/envCheck.mjs";
import { supabaseConfigProblem } from "./supabase";

const KEY = "sb_publishable_TESTONLY_abcdefghijklmnop";
const URL_OK = "https://abcdefghijklmnop.supabase.co";

describe("build-time config values", () => {
  it("accepts plain printable ASCII", () => {
    expect(envValueProblem(KEY)).toBeNull();
    expect(envValueProblem(URL_OK)).toBeNull();
  });

  it("names each kind of bad value without echoing it", () => {
    expect(envValueProblem("")).toBe("is empty");
    expect(envValueProblem(undefined)).toBe("is empty");
    expect(envValueProblem("﻿" + KEY)).toBe("starts with a byte-order mark (BOM)");
    expect(envValueProblem(KEY + "\r\n")).toBe("has leading or trailing whitespace");
    expect(envValueProblem(" " + KEY)).toBe("has leading or trailing whitespace");
    expect(envValueProblem("abc’def")).toBe("has a non-ASCII character at position 4 (U+2019)");
    expect(envValueProblem("ab cd")).toBe("has a control or space character at position 3");
    expect(envValueProblem("ab\u0000cd")).toBe("has a control or space character at position 3");
    for (const bad of ["﻿" + KEY, "abc’def"]) expect(envValueProblem(bad)).not.toContain(bad.slice(1, 6));
  });

  it("firstEnvProblem can skip empty (optional) values", () => {
    expect(firstEnvProblem([["A", ""], ["B", "ok"]], { allowEmpty: true })).toBeNull();
    expect(firstEnvProblem([["A", ""], ["B", "ok"]])).toEqual({ name: "A", problem: "is empty" });
  });
});

describe("app startup check for Supabase", () => {
  it("the BOM'd key that broke sign-in on the phone is caught and named", () => {
    expect(supabaseConfigProblem(URL_OK, "﻿" + KEY)).toEqual({ name: "VITE_SUPABASE_ANON_KEY", problem: "starts with a byte-order mark (BOM)" });
    expect(supabaseConfigProblem("﻿" + URL_OK, "﻿" + KEY)?.name).toBe("VITE_SUPABASE_URL");
  });

  it("good values, or none at all (local mode), pass", () => {
    expect(supabaseConfigProblem(URL_OK, KEY)).toBeNull();
    expect(supabaseConfigProblem(undefined, undefined)).toBeNull();
  });
});

describe("CI guard script", () => {
  const script = path.join(__dirname, "../../scripts/check-build-env.mjs");
  const run = (env: Record<string, string>) =>
    spawnSync(process.execPath, [script, "VITE_SUPABASE_URL", "VITE_SUPABASE_ANON_KEY"], { env: { ...process.env, ...env }, encoding: "utf8" });

  it("passes clean secrets", () => {
    const r = run({ VITE_SUPABASE_URL: URL_OK, VITE_SUPABASE_ANON_KEY: KEY });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("VITE_SUPABASE_ANON_KEY: ok");
  });

  it("fails on a BOM, printing the name and problem but never the value", () => {
    const r = run({ VITE_SUPABASE_URL: URL_OK, VITE_SUPABASE_ANON_KEY: "﻿" + KEY });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("::error title=Bad secret VITE_SUPABASE_ANON_KEY::VITE_SUPABASE_ANON_KEY starts with a byte-order mark (BOM)");
    expect(r.stdout).not.toContain(KEY);
    expect(r.stdout).not.toContain("abcdefghijklmnop");
  });
});
