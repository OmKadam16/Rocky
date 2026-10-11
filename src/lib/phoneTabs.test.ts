import { afterEach, describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  calendarPending,
  DEFAULT_TAB,
  initialTab,
  isKeyboardOpen,
  loadStoredTab,
  needsConfirm,
  saveTab,
  TAB_KEY,
  toastReducer,
} from "./phoneTabs";
import { shouldPersist } from "./chatHistory";
import PhoneTabBar from "../components/phone/PhoneTabBar";

const g = globalThis as unknown as { localStorage?: Storage };
afterEach(() => {
  delete g.localStorage;
});

describe("phone tabs", () => {
  it("opens on Calendar the first time, then the last tab used", () => {
    expect(DEFAULT_TAB).toBe("calendar");
    expect(initialTab("", null)).toBe("calendar");
    expect(initialTab("", "chat")).toBe("chat");
    expect(initialTab("", "settings")).toBe("calendar");
  });

  it("?tab=chat deep link wins over the stored tab", () => {
    expect(initialTab("?tab=chat", "calendar")).toBe("chat");
    expect(initialTab("?pair=ABCD&tab=calendar", "chat")).toBe("calendar");
    expect(initialTab("?tab=nonsense", "chat")).toBe("chat");
  });

  it("remembers the tab in localStorage, and survives storage being unavailable", () => {
    const m = new Map<string, string>();
    g.localStorage = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) } as Storage;
    saveTab("chat");
    expect(m.get(TAB_KEY)).toBe("chat");
    expect(loadStoredTab()).toBe("chat");
    g.localStorage = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    } as unknown as Storage;
    expect(() => saveTab("calendar")).not.toThrow();
    expect(loadStoredTab()).toBeNull();
  });

  it("the tab bar is a tablist with aria-selected, 44px targets and both labels", () => {
    const html = renderToStaticMarkup(createElement(PhoneTabBar, { tab: "chat", onChange: () => {} }));
    expect(html).toMatch(/role="tablist"/);
    expect(html).toMatch(/id="phone-tab-chat"[^>]*aria-selected="true"/);
    expect(html).toMatch(/id="phone-tab-calendar"[^>]*aria-selected="false"/);
    expect(html).toMatch(/h-11/);
    expect(html).toContain("Chat");
    expect(html).toContain("Calendar");
  });
});

describe("keyboard", () => {
  it("is open when it takes a real slice of the screen, not for a URL bar wobble", () => {
    expect(isKeyboardOpen(844, 844)).toBe(false);
    expect(isKeyboardOpen(844, 780)).toBe(false);
    expect(isKeyboardOpen(844, 500)).toBe(true);
  });
});

describe("Calendar tab: toast and pending cards", () => {
  it("a new reply shows; the 2 s idle timeout hides only that reply", () => {
    let s = toastReducer({ id: null, visible: false }, { type: "reply", id: "a" });
    expect(s).toEqual({ id: "a", visible: true });
    expect(toastReducer(s, { type: "reply", id: "a" })).toBe(s); // same reply again: no flicker
    s = toastReducer(s, { type: "reply", id: "b" });
    expect(toastReducer(s, { type: "idle-timeout", id: "a" }).visible).toBe(true); // stale timer
    expect(toastReducer(s, { type: "idle-timeout", id: "b" }).visible).toBe(false);
    expect(toastReducer(s, { type: "dismiss" }).visible).toBe(false);
  });

  it("a pending confirmation or booking run stays in view on the Calendar tab", () => {
    expect(calendarPending({ needsConfirm: true, agentPhase: "idle" })).toBe("confirm");
    expect(calendarPending({ needsConfirm: false, agentPhase: "question" })).toBe("agent");
    expect(calendarPending({ needsConfirm: true, agentPhase: "running" })).toBe("agent");
    expect(calendarPending({ needsConfirm: false, agentPhase: "idle" })).toBeNull();
  });

  it("confirm shows only for a 'say yes or tap Confirm' reply while idle", () => {
    const ask = "Remove both blocks today, Nobu at 7 AM and Nobu Newport Beach at 7 PM? Say yes or tap Confirm.";
    expect(needsConfirm(ask, false, "idle", false)).toBe(true);
    expect(needsConfirm(ask, false, "speaking", false)).toBe(false);
    expect(needsConfirm(ask, true, "idle", false)).toBe(false); // a card has its own buttons
    expect(needsConfirm(ask, false, "idle", true)).toBe(false); // the agent owns the yes
    expect(needsConfirm("Done.", false, "idle", false)).toBe(false);
  });
});

describe("phone chat history", () => {
  it("private turns (Memory) are never saved on the phone; the laptop keeps its old behaviour", () => {
    expect(shouldPersist({ private: true }, false)).toBe(false);
    expect(shouldPersist({ private: false }, false)).toBe(true);
    expect(shouldPersist({}, false)).toBe(true);
    expect(shouldPersist({ private: true }, true)).toBe(true);
  });
});
