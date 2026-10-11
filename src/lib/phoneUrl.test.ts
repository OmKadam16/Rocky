import { describe, expect, it } from "vitest";
import { cleanPhoneUrl, phoneUrlWarning, resolvePhoneUrl } from "./phoneUrl";

describe("phone URL (what the Devices screen tells the phone to open)", () => {
  it("never shows the desktop app's own origin or other non-web schemes", () => {
    expect(cleanPhoneUrl("app://rocky")).toBeNull();
    expect(cleanPhoneUrl("file:///C:/Rocky/index.html")).toBeNull();
    expect(resolvePhoneUrl("app://rocky", null)).toEqual({ url: null, source: null });
  });
  it("tidies what was typed: adds https://, drops trailing slashes, keeps a sub-path", () => {
    expect(cleanPhoneUrl(" rocky.onrender.com/ ")).toBe("https://rocky.onrender.com");
    expect(cleanPhoneUrl("https://om.github.io/Rocky/")).toBe("https://om.github.io/Rocky");
    expect(cleanPhoneUrl("")).toBeNull();
  });
  it("uses the build value, and a saved Phone site address wins over it", () => {
    expect(resolvePhoneUrl("https://rocky.onrender.com", null)).toEqual({ url: "https://rocky.onrender.com", source: "build" });
    expect(resolvePhoneUrl("http://10.9.30.90:8080", "https://rocky.app")).toEqual({ url: "https://rocky.app", source: "setting" });
    expect(resolvePhoneUrl("", "rocky.app")).toEqual({ url: "https://rocky.app", source: "setting" });
    expect(resolvePhoneUrl(undefined, null).url).toBeNull();
  });
  it("warns about addresses a phone can't use well", () => {
    expect(phoneUrlWarning("http://localhost:8080")).toMatch(/only works on this computer/);
    expect(phoneUrlWarning("http://10.9.30.90:8080")).toMatch(/same Wi-Fi/);
    expect(phoneUrlWarning("http://rocky.example.com")).toMatch(/https/);
    expect(phoneUrlWarning("https://rocky.onrender.com")).toBeNull();
  });
});
