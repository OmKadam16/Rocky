/**
 * Startup watchdog: Rocky must never sit on a blank or loading screen.
 *
 * main.tsx starts it before React renders. Each startup step is logged to the
 * console as "[rocky:boot] …" (readable through chrome://inspect on a phone).
 * AuthGate marks the boot ready once it knows whether someone is signed in.
 * If that hasn't happened within 8 s, a plain screen (no React, in case React
 * is what broke) shows the real error or the step it got stuck on, the build
 * version and a Retry button. If the app finishes late, the screen goes away.
 */

export const BOOT_TIMEOUT_MS = 8000;

export type BootInfo = { version: string; steps: string[]; errors: string[]; stuckAt: string | null; elapsedMs: number };

export type Boot = {
  step(name: string): void;
  error(e: unknown): void;
  ready(): void;
  info(): BootInfo;
  isReady(): boolean;
};

type Deps = {
  version: string;
  timeoutMs?: number;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
  log?: (msg: string) => void;
  onStuck: (info: BootInfo) => void;
  onRecovered?: () => void;
};

export function errorText(e: unknown): string {
  if (e instanceof Error) return e.stack && !e.stack.startsWith(e.message) ? `${e.message}\n${e.stack}` : e.stack || e.message;
  if (typeof e === "string") return e;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}

export function createBoot(d: Deps): Boot {
  const now = d.now ?? (() => Date.now());
  const setTimer = d.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = d.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
  const log = d.log ?? ((m) => console.info(m));
  const t0 = now();
  const steps: string[] = [];
  const errors: string[] = [];
  let ready = false;
  let stuck = false;

  const info = (): BootInfo => ({
    version: d.version,
    steps: [...steps],
    errors: [...errors],
    stuckAt: ready ? null : steps[steps.length - 1] ?? null,
    elapsedMs: now() - t0,
  });

  const timer = setTimer(() => {
    if (ready) return;
    stuck = true;
    log(`[rocky:boot] not ready after ${d.timeoutMs ?? BOOT_TIMEOUT_MS} ms (last step: ${steps[steps.length - 1] ?? "none"})`);
    d.onStuck(info());
  }, d.timeoutMs ?? BOOT_TIMEOUT_MS);

  return {
    step(name) {
      steps.push(name);
      log(`[rocky:boot] ${name} (+${now() - t0} ms)`);
    },
    error(e) {
      const text = errorText(e);
      errors.push(text);
      log(`[rocky:boot] error: ${text.split("\n")[0]}`);
    },
    ready() {
      if (ready) return;
      ready = true;
      clearTimer(timer);
      log(`[rocky:boot] ready (+${now() - t0} ms)`);
      if (stuck) d.onRecovered?.();
    },
    info,
    isReady: () => ready,
  };
}

/** The text of the failure screen (also what a test checks). */
export function bootFailureLines(i: BootInfo): { title: string; detail: string; meta: string } {
  const detail = i.errors.length
    ? i.errors[i.errors.length - 1]
    : `Still starting after ${Math.round(i.elapsedMs / 1000)} s. Stuck at: ${i.stuckAt ?? "before the first step"}.`;
  return { title: "Rocky could not start", detail, meta: `Version ${i.version} · steps: ${i.steps.join(" → ") || "none"}` };
}

const SCREEN_ID = "rocky-boot-failure";

export function showScreen(i: BootInfo) {
  if (typeof document === "undefined") return;
  document.getElementById(SCREEN_ID)?.remove();
  const { title, detail, meta } = bootFailureLines(i);
  const wrap = document.createElement("div");
  wrap.id = SCREEN_ID;
  wrap.setAttribute("role", "alert");
  wrap.style.cssText =
    "position:fixed;inset:0;z-index:2147483647;overflow:auto;display:flex;align-items:center;justify-content:center;padding:24px;" +
    "background:var(--color-canvas,#f4f3f0);color:var(--color-ink,#17191a);font-family:'Space Grotesk',system-ui,sans-serif";
  const box = document.createElement("div");
  box.style.cssText = "max-width:560px;width:100%";
  const h = document.createElement("h1");
  h.textContent = title;
  h.style.cssText = "margin:0;font-size:26px;font-weight:500;letter-spacing:-0.02em";
  const pre = document.createElement("pre");
  pre.textContent = detail; // textContent: page text is never parsed as HTML
  pre.style.cssText = "margin:16px 0 0;white-space:pre-wrap;word-break:break-word;font:12px/1.6 'IBM Plex Mono',ui-monospace,monospace;max-height:40vh;overflow:auto";
  const m = document.createElement("p");
  m.textContent = meta;
  m.style.cssText = "margin:12px 0 0;font:11px/1.5 'IBM Plex Mono',ui-monospace,monospace;color:var(--color-grey-mid,#a5a29a)";
  const btn = document.createElement("button");
  btn.type = "button";
  btn.textContent = "Retry";
  btn.style.cssText =
    "margin-top:20px;height:44px;padding:0 22px;border:0;border-radius:3px;cursor:pointer;font:500 15px 'Space Grotesk',system-ui,sans-serif;" +
    "background:var(--color-ink,#17191a);color:var(--color-canvas,#f4f3f0)";
  btn.onclick = () => location.reload();
  box.append(h, pre, m, btn);
  wrap.append(box);
  document.body.append(wrap);
}

let current: Boot | null = null;

/** Starts the watchdog once (main.tsx) and catches errors nothing else handles. */
export function startBoot(version: string): Boot {
  if (current) return current;
  const boot = createBoot({
    version,
    onStuck: showScreen,
    onRecovered: () => document.getElementById(SCREEN_ID)?.remove(),
  });
  if (typeof window !== "undefined") {
    window.addEventListener("error", (e) => {
      if (!boot.isReady()) boot.error(e.error ?? e.message);
    });
    window.addEventListener("unhandledrejection", (e) => {
      if (!boot.isReady()) boot.error(e.reason);
    });
  }
  current = boot;
  return boot;
}

/** Safe from anywhere (tests, non-browser): a no-op before startBoot. */
export const bootStep = (name: string) => current?.step(name);
export const bootError = (e: unknown) => current?.error(e);
export const bootReady = () => current?.ready();
