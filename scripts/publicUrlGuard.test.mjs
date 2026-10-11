import { describe, expect, it } from "vitest";
import { checkPublicUrl } from "./publicUrlGuard.mjs";

describe("build guard for VITE_PUBLIC_URL", () => {
  it("warns loudly when unset, and fails in strict mode", () => {
    expect(checkPublicUrl("").level).toBe("warn");
    expect(checkPublicUrl(undefined).message).toMatch(/Phone site address/);
    expect(checkPublicUrl("", { strict: true }).level).toBe("error");
  });
  it("fails on a non-web address (app://rocky can't be opened on a phone)", () => {
    expect(checkPublicUrl("app://rocky").level).toBe("error");
    expect(checkPublicUrl("not a url").level).toBe("error");
  });
  it("warns on localhost, LAN and plain-http addresses", () => {
    expect(checkPublicUrl("http://localhost:8080").level).toBe("warn");
    expect(checkPublicUrl("http://10.9.30.90:8080").level).toBe("warn");
    expect(checkPublicUrl("http://rocky.example.com").level).toBe("warn");
  });
  it("accepts an https site", () => {
    expect(checkPublicUrl("https://rocky.onrender.com/").level).toBe("ok");
  });
});
