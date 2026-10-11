import { describe, expect, it } from "vitest";
import { BOOT_TIMEOUT_MS, bootFailureLines, createBoot, type BootInfo } from "./boot";

function harness() {
  let t = 0;
  let fire: (() => void) | null = null;
  let cleared = false;
  const stuck: BootInfo[] = [];
  let recovered = 0;
  const boot = createBoot({
    version: "9.9.9",
    now: () => t,
    setTimer: (fn, ms) => {
      expect(ms).toBe(BOOT_TIMEOUT_MS);
      fire = fn;
      return 1;
    },
    clearTimer: () => void (cleared = true),
    log: () => {},
    onStuck: (i) => stuck.push(i),
    onRecovered: () => void recovered++,
  });
  return { boot, stuck, advance: (ms: number) => void (t += ms), fire: () => fire?.(), wasCleared: () => cleared, recovered: () => recovered };
}

describe("startup watchdog", () => {
  it("waits 8 seconds", () => expect(BOOT_TIMEOUT_MS).toBe(8000));

  it("a ready boot never shows the failure screen", () => {
    const h = harness();
    h.boot.step("render");
    h.boot.ready();
    expect(h.wasCleared()).toBe(true);
    h.fire();
    expect(h.stuck).toEqual([]);
  });

  it("a boot stuck on a step shows that step and the version", () => {
    const h = harness();
    h.boot.step("render phone UI");
    h.boot.step("auth: reading the saved session");
    h.advance(8000);
    h.fire();
    expect(h.stuck).toHaveLength(1);
    const l = bootFailureLines(h.stuck[0]);
    expect(l.title).toBe("Rocky could not start");
    expect(l.detail).toContain("Stuck at: auth: reading the saved session");
    expect(l.detail).toContain("8 s");
    expect(l.meta).toContain("Version 9.9.9");
  });

  it("shows the real error text when there is one", () => {
    const h = harness();
    h.boot.step("render");
    h.boot.error(new Error("Failed to fetch dynamically imported module"));
    h.fire();
    expect(bootFailureLines(h.stuck[0]).detail).toContain("Failed to fetch dynamically imported module");
  });

  it("a late finish takes the failure screen away", () => {
    const h = harness();
    h.fire();
    h.boot.ready();
    expect(h.recovered()).toBe(1);
  });
});
