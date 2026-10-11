/**
 * Phone shell logic (pure; tested in phoneTabs.test.ts): which tab is open,
 * when the keyboard is up, the reply toast on the Calendar tab, and what
 * must stay visible there (a pending confirmation or a booking run).
 */

export type PhoneTab = "chat" | "calendar";
export const TAB_KEY = "rocky-phone-tab";
export const DEFAULT_TAB: PhoneTab = "calendar";

const isTab = (v: unknown): v is PhoneTab => v === "chat" || v === "calendar";

/** ?tab=chat|calendar wins, then the last tab used, then Calendar. */
export function initialTab(search: string, stored: string | null): PhoneTab {
  try {
    const q = new URLSearchParams(search).get("tab");
    if (isTab(q)) return q;
  } catch {
    /* malformed query */
  }
  return isTab(stored) ? stored : DEFAULT_TAB;
}

export function loadStoredTab(): string | null {
  try {
    return localStorage.getItem(TAB_KEY);
  } catch {
    return null;
  }
}

export function saveTab(tab: PhoneTab): void {
  try {
    localStorage.setItem(TAB_KEY, tab);
  } catch {
    /* private mode: the tab just isn't remembered */
  }
}

/** The on-screen keyboard takes this much of the layout viewport or more. */
const KEYBOARD_MIN_PX = 150;

export function isKeyboardOpen(layoutHeight: number, visualHeight: number): boolean {
  return layoutHeight - visualHeight > KEYBOARD_MIN_PX;
}

/** "say yes or tap Confirm" waiting on the user, with nothing else going on. */
export function needsConfirm(lastAssistantText: string | null, hasCard: boolean, state: string, agentBusy: boolean): boolean {
  return Boolean(lastAssistantText && !hasCard && /say yes or tap confirm/i.test(lastAssistantText) && state === "idle" && !agentBusy);
}

/** What the Calendar tab must still show above the nav, so nothing is missed. */
export function calendarPending(p: { needsConfirm: boolean; agentPhase: string }): "agent" | "confirm" | null {
  if (p.agentPhase !== "idle") return "agent";
  if (p.needsConfirm) return "confirm";
  return null;
}

// ---------------------------------------------------------------------------
// Reply toast (Calendar tab): a new reply shows; once the turn is over it
// clears after TOAST_MS. Errors never auto-hide.
// ---------------------------------------------------------------------------

export const TOAST_MS = 2000;

export type ToastState = { id: string | null; visible: boolean };

export type ToastEvent =
  | { type: "reply"; id: string }
  | { type: "idle-timeout"; id: string }
  | { type: "dismiss" };

export function toastReducer(s: ToastState, e: ToastEvent): ToastState {
  switch (e.type) {
    case "reply":
      return e.id === s.id ? s : { id: e.id, visible: true };
    case "idle-timeout":
      return e.id === s.id ? { ...s, visible: false } : s;
    case "dismiss":
      return { ...s, visible: false };
  }
}
