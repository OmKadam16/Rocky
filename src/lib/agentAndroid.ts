/**
 * The booking agent ON the phone (Android app): the same run loop and gates
 * as the desktop (shared/agentCore.mjs + shared/agentPageScripts.mjs), with
 * the RockyAgentBrowser plugin (android/…/RockyAgentBrowserPlugin.kt) as its
 * browser. It plugs into agentClient as the local agent, so the AgentCard,
 * the voice loop, the planner tools, codes and confirmations all work as on
 * the laptop. Older APKs without the plugin keep using the laptop relay.
 *
 * Nothing here decides what is safe: BookingRun does (two confirmations,
 * never card / password / 2FA / ID, CAPTCHA + payment handed to the user,
 * the narrow booking-code exception, step / time / loop caps, evidence-based
 * "booked"). This file only drives the WebView and relays events.
 */
import { BookingRun, OPENAI_RESPONSES_URL, startUrlFor, type AgentDeps, type InputStep, type Viewport } from "../../shared/agentCore.mjs";
import * as P from "../../shared/agentPageScripts.mjs";
import type { AgentEvent, CodeResult } from "./agentClient";
import type { AgentTask } from "./bookingTask";

/** The plugin surface (all coordinates CSS px). Mocked in agentAndroid.test.ts. */
export type AgentBrowser = {
  open(o: { show: boolean }): Promise<Viewport>;
  navigate(o: { url: string }): Promise<{ url: string; timedOut?: boolean }>;
  screenshot(o: { quality: number }): Promise<{ dataUrl: string; width: number; height: number }>;
  pointer(o: { action: "down" | "move" | "up"; x: number; y: number }): Promise<void>;
  key(o: { action: "down" | "up"; key: string }): Promise<{ ok: boolean }>;
  insertText(o: { text: string }): Promise<{ ok: boolean }>;
  evaluate(o: { code: string }): Promise<{ json: string }>;
  history(o: { dir: "back" | "forward" }): Promise<void>;
  state(): Promise<{ open: boolean; shown: boolean; url: string; title: string; loading: boolean; width: number; height: number }>;
  setBanner(o: { title: string; text: string }): Promise<void>;
  show(): Promise<void>;
  hide(): Promise<void>;
  close(): Promise<void>;
  addListener(event: "stop" | "hidden", fn: () => void): Promise<{ remove: () => Promise<void> }>;
};

const sleepMs = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Scroll the element under the point (or the page) — Android has no wheel events. */
export const SCROLL_JS = (x: number, y: number, dx: number, dy: number) => `(() => {
  let el = document.elementFromPoint(${x}, ${y});
  while (el && el !== document.body && el !== document.documentElement) {
    const s = getComputedStyle(el);
    if (/(auto|scroll)/.test(s.overflowY + " " + s.overflowX) && (el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1)) { el.scrollBy(${dx}, ${dy}); return "element"; }
    el = el.parentElement;
  }
  window.scrollBy(${dx}, ${dy});
  return "page";
})()`;
const NET_JS = `performance.getEntriesByType("resource").length`;
const MASK_JS = `(() => { const s = document.createElement("style"); s.textContent = ${JSON.stringify(P.MASK_CSS)}; (document.head || document.documentElement).appendChild(s); return true; })()`;

const UNKNOWN_FRAME_FIELD = { tag: "iframe", type: "", name: "", id: "", autocomplete: "", placeholder: "", label: "", ariaLabel: "" };

/** The browser half of the agent deps, built on the plugin. */
export function createBrowserDriver(browser: AgentBrowser, opts: { sleep?: (ms: number) => Promise<void>; now?: () => number } = {}) {
  const sleep = opts.sleep ?? sleepMs;
  const now = opts.now ?? (() => Date.now());

  const evalJson = async <T = unknown>(code: string): Promise<T | null> => {
    const r = await browser.evaluate({ code });
    try {
      return JSON.parse(r.json) as T;
    } catch {
      return null;
    }
  };

  const driver: Omit<AgentDeps, "callModel" | "emit" | "now" | "sleep"> = {
    screenshot: () => browser.screenshot({ quality: 80 }),
    navigate: async (url) => {
      if (!/^https?:\/\//i.test(url)) throw new Error("The agent opens http(s) pages only.");
      await browser.navigate({ url });
    },
    history: (dir) => browser.history({ dir }),
    input: async (step: InputStep) => {
      if ("insertText" in step) {
        await browser.insertText({ text: step.insertText });
        return;
      }
      const e = step.input;
      switch (e.type) {
        case "mouseMove":
          await browser.pointer({ action: "move", x: e.x ?? 0, y: e.y ?? 0 });
          await sleep(15);
          return;
        case "mouseDown":
          await browser.pointer({ action: "down", x: e.x ?? 0, y: e.y ?? 0 });
          await sleep(15);
          return;
        case "mouseUp":
          await browser.pointer({ action: "up", x: e.x ?? 0, y: e.y ?? 0 });
          await sleep(60);
          return;
        case "mouseWheel":
          // Chromium's wheel deltas are negative for "down"; scrollBy wants positive.
          await evalJson(SCROLL_JS(e.x ?? 0, e.y ?? 0, -(e.deltaX ?? 0), -(e.deltaY ?? 0)));
          await sleep(60);
          return;
        case "keyDown":
        case "keyUp": {
          const k = String(e.keyCode ?? "");
          if (k.length > 1) await browser.key({ action: e.type === "keyUp" ? "up" : "down", key: k });
          await sleep(e.type === "keyUp" ? 60 : 15);
          return;
        }
        case "char": {
          const ch = String(e.keyCode ?? "");
          // Enter / named keys already went in as key events; plain characters type.
          if (ch.length === 1 && ch !== "\r") await browser.insertText({ text: ch });
          return;
        }
        default:
          return;
      }
    },
    settle: async (o = {}) => {
      if (o.afterScroll) {
        // Same as desktop: don't shoot mid-scroll. Wait for the scroll
        // position to hold still (well under a second).
        let last: string | null = null;
        let still = now();
        const t0 = now();
        for (;;) {
          const pos = await evalJson<string>(P.SCROLL_POS_JS).catch(() => null);
          const t = now();
          if (pos != null && pos === last && t - still >= 150) break;
          if (pos !== last) { last = pos; still = t; }
          if (t - t0 > 1200) break;
          await sleep(60);
        }
      }
      const start = now();
      const minMs = o.minMs ?? (o.afterType ? 300 : 120);
      const cap = o.capMs ?? P.SETTLE_CAP_MS;
      let lastNet = -1;
      let netStableSince = now();
      for (;;) {
        const elapsed = now() - start;
        const st = await browser.state().catch(() => null);
        const loading = Boolean(st?.loading);
        if (elapsed >= (loading ? Math.max(cap, P.NAV_CAP_MS) : cap)) break;
        const net = Number(await evalJson<number>(NET_JS).catch(() => lastNet));
        if (net !== lastNet) {
          lastNet = net;
          netStableSince = now();
        }
        const netIdle = now() - netStableSince >= Math.min(P.STALE_REQUEST_MS, 300);
        if (elapsed >= minMs && !loading && netIdle) {
          const quiet = Number(await evalJson<number>(P.QUIET_JS).catch(() => P.QUIET_MS));
          if (quiet >= P.QUIET_MS) break;
        }
        await sleep(60);
      }
    },
    probe: async () => {
      const main = (await evalJson<Record<string, unknown>>(P.PROBE_JS).catch(() => null)) ?? {};
      const st = await browser.state().catch(() => null);
      return { url: st?.url ?? "", title: st?.title ?? "", ...main };
    },
    describePoint: async (x, y) => {
      const res = await evalJson<Record<string, unknown>>(P.POINT_JS(x, y)).catch(() => null);
      // Android can't look inside a frame: the core treats this as possibly final.
      if (res && res.frame != null) return { tag: "iframe", text: "", unresolvedFrame: true };
      return res;
    },
    describeFocus: async () => {
      const res = await evalJson<Record<string, unknown>>(P.FOCUS_JS).catch(() => null);
      if (res && res.frame != null) return UNKNOWN_FRAME_FIELD;
      return res;
    },
    pageText: async () => String((await evalJson<string>(P.TEXT_JS).catch(() => "")) ?? "").slice(0, 40000),
    codeContext: async () => {
      const st = await browser.state().catch(() => null);
      const base = { url: st?.url ?? "", title: st?.title ?? "" };
      const ctx = await evalJson<Record<string, unknown>>(P.CODE_CTX_JS).catch(() => null);
      if (ctx) return { ...base, ...ctx };
      const text = String((await evalJson<string>(P.TEXT_JS).catch(() => "")) ?? "").slice(0, 1500);
      return { ...base, text, hasPassword: false, count: 0, split: false };
    },
    /**
     * Types the site's code: masked first, then one digit per box (split) or
     * the whole code, as key events. The code is never in a script string.
     */
    fillCode: async (code, point) => {
      const masked = Boolean(await evalJson<boolean>(MASK_JS).catch(() => false));
      const ctx = await evalJson<{ count: number; split: boolean }>(P.CODE_CTX_JS).catch(() => null);
      if (ctx && ctx.count > 0) {
        const split = ctx.split && ctx.count >= code.length;
        const parts = split ? code.split("") : [code];
        for (let i = 0; i < parts.length; i += 1) {
          if (!(await evalJson<boolean>(P.FOCUS_CODE_JS(i)).catch(() => false))) return { ok: false, masked };
          await browser.insertText({ text: parts[i] });
          for (let t = 0; t < 15; t += 1) {
            if (Number(await evalJson<number>(P.BOX_LEN_JS(i)).catch(() => -1)) >= parts[i].length) break;
            await sleep(20);
          }
        }
        for (let t = 0; t < 20; t += 1) {
          if (Number(await evalJson<number>(P.CODE_LEN_JS).catch(() => -1)) >= code.length) break;
          await sleep(50);
        }
        return { ok: true, masked };
      }
      if (!point) return { ok: false, masked };
      await browser.pointer({ action: "down", x: point.x, y: point.y });
      await sleep(15);
      await browser.pointer({ action: "up", x: point.x, y: point.y });
      await sleep(60);
      const marked = await evalJson<boolean>(P.MARK_FOCUSED_JS).catch(() => false);
      if (!marked) return { ok: false, masked: false };
      await browser.insertText({ text: code });
      return { ok: true, masked };
    },
  };
  return driver;
}

/** OpenAI Responses call, phone -> api.openai.com directly (same retries as the desktop). */
export function createModelCaller(getKey: () => Promise<string | null>, fetchFn: typeof fetch = fetch, sleep = sleepMs) {
  return async (body: unknown) => {
    const key = await getKey();
    if (!key) throw new Error("No browser key. Add it in Profile → Model.");
    for (let attempt = 0; ; attempt += 1) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 120000);
      let res: Response;
      try {
        res = await fetchFn(OPENAI_RESPONSES_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
          body: JSON.stringify(body),
          signal: ctrl.signal,
        });
      } finally {
        clearTimeout(timer);
      }
      if (res.ok) return res.json();
      const detail = await res.text().catch(() => "");
      if ((res.status === 429 || res.status >= 500) && attempt < 2) {
        await sleep(2000 * (attempt + 1));
        continue;
      }
      let msg = detail;
      try {
        msg = (JSON.parse(detail) as { error: { message: string } }).error.message;
      } catch {
        /* keep raw */
      }
      throw new Error(`OpenAI ${res.status}: ${String(msg).slice(0, 200)}`);
    }
  };
}

export const RUN_MARKER = "rocky-agent-run";
type Storage = { get(k: string): string | null; set(k: string, v: string): void; remove(k: string): void };

/** The local-agent bridge (same shape as the desktop's window.rocky.agent). */
export function createAndroidAgent(deps: {
  browser: AgentBrowser;
  callModel: (body: unknown) => Promise<unknown>;
  hasKey: () => Promise<boolean>;
  storage: Storage;
  keepAwake?: (on: boolean) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  limits?: Record<string, number>;
}) {
  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? sleepMs;
  const driver = createBrowserDriver(deps.browser, { now, sleep });
  const handlers = new Set<(e: AgentEvent) => void>();
  let run: BookingRun | null = null;
  let log: { text: string; blocked: boolean }[] = [];
  let pause: Record<string, string> | null = null;
  let prepared: { url: string; at: number; promise: Promise<unknown> } | null = null;
  let viewport: Viewport | null = null;

  const active = () => Boolean(run && !["done", "failed", "cancelled"].includes(run.state));
  const banner = (title: string, text: string) => void deps.browser.setBanner({ title, text }).catch(() => {});

  void deps.browser.addListener("stop", () => {
    if (run) run.cancel("Stopped from the agent browser. Nothing more will be clicked.");
  });

  const emit = (raw: Record<string, unknown> & { type: string }) => {
    const e = raw as unknown as AgentEvent;
    switch (e.type) {
      case "step":
        log = [...log, { text: e.text, blocked: Boolean(e.blocked) }].slice(-200);
        banner("Rocky is driving", e.text);
        break;
      case "status":
        banner(e.state === "running" ? "Rocky is driving" : "Rocky is paused", e.text);
        // Back to work after an answer: show the page again.
        if (e.state === "running") void deps.browser.show().catch(() => {});
        break;
      case "question":
        pause = { kind: "question", question: e.question, field: e.field };
        banner("Rocky is paused", `Waiting for your answer: ${e.question}`);
        void deps.browser.hide().catch(() => {}); // the question is in Rocky
        break;
      case "code_request":
        pause = { kind: "code", channel: e.channel, attempt: String(e.attempt) };
        banner("Rocky is paused", "Waiting for the code the site sent you");
        void deps.browser.hide().catch(() => {});
        break;
      case "needs_confirmation":
        pause = { kind: "confirm", summary: e.summary, confirmKind: e.kind };
        banner("Rocky is paused", "Waiting for your yes in Rocky");
        void deps.browser.hide().catch(() => {});
        break;
      case "needs_user_takeover":
        pause = { kind: "takeover", reason: e.reason, message: e.message };
        banner("Your turn", e.message);
        void deps.browser.show().catch(() => {}); // the user taps in the page
        break;
      case "done":
      case "failed":
      case "cancelled":
        pause = null;
        deps.storage.remove(RUN_MARKER);
        deps.keepAwake?.(false);
        banner(e.type === "done" ? (e.status === "booked" ? "Booked" : "Check the page") : "Stopped", e.type === "done" ? (e.reference ?? "") : e.type === "failed" ? e.reason : e.message);
        break;
    }
    for (const h of handlers) {
      try {
        h(e);
      } catch {
        /* a broken listener must not stop the run */
      }
    }
  };

  async function ensureOpen(show: boolean) {
    const st = await deps.browser.state().catch(() => null);
    if (st?.open && st.width > 0) {
      viewport = { width: st.width, height: st.height };
      if (show) await deps.browser.show().catch(() => {});
      return;
    }
    viewport = await deps.browser.open({ show });
  }

  return {
    available: async () => true,
    prepare: async (task: AgentTask) => {
      if (active()) return { ok: false };
      const url = startUrlFor(task);
      if (!/^https?:\/\//i.test(url)) return { ok: false };
      await ensureOpen(false);
      if (prepared?.url === url) return { ok: true };
      prepared = { url, at: now(), promise: driver.navigate(url).catch(() => {}) };
      banner("Rocky is ready", "Opened the booking page. Waiting for your yes.");
      return { ok: true };
    },
    start: async (task: AgentTask): Promise<{ ok?: boolean; error?: string }> => {
      if (active()) return { error: "A booking is already running. Stop it first." };
      if (!(await deps.hasKey())) return { error: "No browser key. Add it in Profile → Model." };
      await ensureOpen(true);
      log = [];
      pause = null;
      const p = prepared;
      prepared = null;
      const navigateRun = async (url: string) => {
        if (p && p.url === url && now() - p.at < 10 * 60_000) {
          await p.promise;
          return;
        }
        await driver.navigate(url);
      };
      run = new BookingRun(task, { ...driver, navigate: navigateRun, callModel: deps.callModel, emit, now, sleep }, { limits: deps.limits, viewport: viewport ?? undefined });
      // If Android kills the app mid-run, the next start marks the hold.
      deps.storage.set(RUN_MARKER, JSON.stringify({ holdBlockId: run.task.holdBlockId ?? null, at: now() }));
      deps.keepAwake?.(true);
      void run.start();
      return { ok: true };
    },
    answer: async (text: string) => Boolean(run && run.answer(String(text).slice(0, 500))),
    /** The site's code: straight into the run, never logged or relayed. */
    code: async (text: string): Promise<CodeResult> => (run ? ((await run.submitCode(String(text).slice(0, 120))) as CodeResult) : { ok: false, error: "not_waiting" }),
    confirm: async (yes: boolean) => Boolean(run && run.confirm(yes === true)),
    continue: async () => Boolean(run && run.continueRun()),
    cancel: async () => Boolean(run && run.cancel()),
    state: async () => ({ active: active(), state: run ? run.state : "idle", pause: active() ? pause : null, log: log.slice(-50) }),
    onEvent: (h: (e: AgentEvent) => void) => {
      handlers.add(h);
      return () => void handlers.delete(h);
    },
    /** Bring the agent browser back on screen (AgentCard "Show browser"). */
    showBrowser: () => deps.browser.show(),
  };
}

export type AndroidAgent = ReturnType<typeof createAndroidAgent>;

/**
 * App start: a run marker with no live run means Android killed the app
 * mid-booking. Mark the calendar hold so the user finishes it by hand.
 */
export async function recoverInterruptedRun(
  storage: Storage,
  markHold: (holdBlockId: string) => Promise<void>,
): Promise<boolean> {
  const raw = storage.get(RUN_MARKER);
  if (!raw) return false;
  storage.remove(RUN_MARKER);
  try {
    const m = JSON.parse(raw) as { holdBlockId?: string | null };
    if (m.holdBlockId) await markHold(m.holdBlockId);
  } catch {
    /* nothing to mark */
  }
  return true;
}
