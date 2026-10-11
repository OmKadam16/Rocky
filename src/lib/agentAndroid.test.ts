import { describe, expect, it, vi } from "vitest";
import { createAndroidAgent, createBrowserDriver, recoverInterruptedRun, RUN_MARKER, SCROLL_JS, type AgentBrowser } from "./agentAndroid";
import { toInputSteps } from "../../shared/agentCore.mjs";

/** A mock RockyAgentBrowser: records every call; evaluate answers by script. */
function mockBrowser(answers: (code: string) => unknown = () => null) {
  const calls: { m: string; a: unknown }[] = [];
  const listeners: Record<string, () => void> = {};
  const rec = (m: string) => async (a?: unknown) => void calls.push({ m, a });
  const b: AgentBrowser = {
    open: async (o) => (calls.push({ m: "open", a: o }), { width: 412, height: 780 }),
    navigate: async (o) => (calls.push({ m: "navigate", a: o }), { url: o.url }),
    screenshot: async () => ({ dataUrl: "data:image/jpeg;base64,AAAA", width: 412, height: 780 }),
    pointer: rec("pointer") as AgentBrowser["pointer"],
    key: async (o) => (calls.push({ m: "key", a: o }), { ok: true }),
    insertText: async (o) => (calls.push({ m: "insertText", a: o }), { ok: true }),
    evaluate: async (o) => (calls.push({ m: "evaluate", a: o }), { json: JSON.stringify(answers(o.code) ?? null) }),
    history: rec("history") as AgentBrowser["history"],
    state: async () => ({ open: true, shown: true, url: "https://site.test/book", title: "Book", loading: false, width: 412, height: 780 }),
    setBanner: rec("setBanner") as AgentBrowser["setBanner"],
    show: rec("show") as AgentBrowser["show"],
    hide: rec("hide") as AgentBrowser["hide"],
    close: rec("close") as AgentBrowser["close"],
    addListener: async (ev, fn) => ((listeners[ev] = fn), { remove: async () => {} }),
  };
  return { b, calls, listeners };
}

const noSleep = async () => {};
const of = (calls: { m: string; a: unknown }[], m: string) => calls.filter((c) => c.m === m).map((c) => c.a);

describe("Android agent driver (plugin contract)", () => {
  it("a click is a touch down + up at the same CSS point (no hover on touch)", async () => {
    const { b, calls } = mockBrowser();
    const d = createBrowserDriver(b, { sleep: noSleep });
    for (const s of toInputSteps({ type: "click", x: 200, y: 300 }, { x: 1, y: 1 }, { width: 412, height: 780 })) await d.input(s);
    expect(of(calls, "pointer")).toEqual([
      { action: "move", x: 200, y: 300 },
      { action: "down", x: 200, y: 300 },
      { action: "up", x: 200, y: 300 },
    ]);
  });

  it("scroll turns the wheel into scrollBy on the element under the point (down = positive)", async () => {
    const { b, calls } = mockBrowser();
    const d = createBrowserDriver(b, { sleep: noSleep });
    for (const s of toInputSteps({ type: "scroll", x: 100, y: 400, scroll_x: 0, scroll_y: 300 }, { x: 1, y: 1 }, { width: 412, height: 780 })) await d.input(s);
    const codes = (of(calls, "evaluate") as { code: string }[]).map((c) => c.code);
    expect(codes).toContain(SCROLL_JS(100, 400, -0, 300));
  });

  it("named keys go as key events; typed text and plain characters as text", async () => {
    const { b, calls } = mockBrowser();
    const d = createBrowserDriver(b, { sleep: noSleep });
    for (const s of toInputSteps({ type: "keypress", keys: ["Enter"] }, { x: 1, y: 1 })) await d.input(s);
    for (const s of toInputSteps({ type: "keypress", keys: ["a"] }, { x: 1, y: 1 })) await d.input(s);
    for (const s of toInputSteps({ type: "type", text: "Om Kadam" }, { x: 1, y: 1 })) await d.input(s);
    expect(of(calls, "key")).toEqual([
      { action: "down", key: "Enter" },
      { action: "up", key: "Enter" },
    ]);
    expect(of(calls, "insertText")).toEqual([{ text: "a" }, { text: "Om Kadam" }]);
  });

  it("a click into a frame Android can't see inside is reported as such (the core then treats it as possibly final)", async () => {
    const { b } = mockBrowser((code) => (code.includes("elementFromPoint") ? { frame: 0, left: 0, top: 0 } : code.includes("activeElement") ? { frame: 1 } : null));
    const d = createBrowserDriver(b, { sleep: noSleep });
    expect(await d.describePoint(10, 10)).toEqual({ tag: "iframe", text: "", unresolvedFrame: true });
    expect((await d.describeFocus())?.tag).toBe("iframe");
  });

  it("probe merges page signals with the url and title", async () => {
    const { b } = mockBrowser((code) => (code.includes("hasCaptcha") ? { hasPassword: false, hasCaptcha: true, hasCardField: false, hasTwoFactor: false } : null));
    const d = createBrowserDriver(b, { sleep: noSleep });
    expect(await d.probe()).toMatchObject({ url: "https://site.test/book", title: "Book", hasCaptcha: true });
  });

  it("the verification code is typed as text and never appears in any page script", async () => {
    const { b, calls } = mockBrowser((code) => {
      if (code.includes("data-rocky-code") && code.includes("count")) return { count: 6, split: true, text: "We texted a code", hasPassword: false };
      if (code.includes("e.focus()")) return true;
      if (code.includes(".length")) return 6;
      return true;
    });
    const d = createBrowserDriver(b, { sleep: noSleep });
    const r = await d.fillCode("427199", null);
    expect(r.ok).toBe(true);
    expect(r.masked).toBe(true);
    expect(of(calls, "insertText")).toEqual(["4", "2", "7", "1", "9", "9"].map((text) => ({ text })));
    const scripts = (of(calls, "evaluate") as { code: string }[]).map((c) => c.code).join("\n");
    expect(scripts).not.toContain("427199");
  });

  it("settle ends by its cap even if the page never goes quiet", async () => {
    let t = 0;
    const { b } = mockBrowser((code) => (code.includes("getEntriesByType") ? t : 0));
    const d = createBrowserDriver(b, { sleep: async (ms) => void (t += ms), now: () => t });
    await d.settle({ capMs: 1000 });
    expect(t).toBeGreaterThanOrEqual(1000);
    expect(t).toBeLessThan(1300);
  });

  it("navigate refuses anything but http(s)", async () => {
    const { b } = mockBrowser();
    const d = createBrowserDriver(b, { sleep: noSleep });
    await expect(d.navigate("intent://evil")).rejects.toThrow(/http/);
  });
});

describe("Android agent controller", () => {
  const storage = () => {
    const m = new Map<string, string>();
    return { m, get: (k: string) => m.get(k) ?? null, set: (k: string, v: string) => void m.set(k, v), remove: (k: string) => void m.delete(k) };
  };

  it("without a browser key it doesn't start", async () => {
    const { b } = mockBrowser();
    const a = createAndroidAgent({ browser: b, callModel: async () => ({}), hasKey: async () => false, storage: storage(), sleep: noSleep });
    expect(await a.start({ type: "restaurant", venue: "X" } as never)).toEqual({ error: "No browser key. Add it in Profile → Model." });
  });

  it("a run keeps the screen on, leaves a run marker, and Stop cancels it", async () => {
    const { b, listeners } = mockBrowser();
    const st = storage();
    const awake: boolean[] = [];
    const events: string[] = [];
    // A model that never finishes: the run waits on it until Stop.
    let release: () => void = () => {};
    const callModel = () => new Promise((r) => (release = () => r({ id: "r1", output: [] })));
    const a = createAndroidAgent({ browser: b, callModel, hasKey: async () => true, storage: st, keepAwake: (on) => awake.push(on), sleep: noSleep });
    a.onEvent((e) => events.push(e.type));
    expect(await a.start({ type: "restaurant", venue: "Testaurant", startUrl: "https://site.test/" } as never)).toEqual({ ok: true });
    expect(awake).toEqual([true]);
    expect(st.get(RUN_MARKER)).not.toBeNull();
    await vi.waitFor(() => expect(listeners.stop).toBeTypeOf("function"));
    listeners.stop();
    release();
    await vi.waitFor(() => expect(events).toContain("cancelled"));
    expect(awake).toEqual([true, false]);
    expect(st.get(RUN_MARKER)).toBeNull();
  });

  it("after Android killed the app mid-run, the hold is marked 'finish by hand' once", async () => {
    const st = storage();
    st.set(RUN_MARKER, JSON.stringify({ holdBlockId: "hold-1" }));
    const marked: string[] = [];
    expect(await recoverInterruptedRun(st, async (id) => void marked.push(id))).toBe(true);
    expect(marked).toEqual(["hold-1"]);
    expect(await recoverInterruptedRun(st, async (id) => void marked.push(id))).toBe(false);
  });
});
