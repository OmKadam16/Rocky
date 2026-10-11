"use strict";
/**
 * Booking Agent v2: the visible agent window and the run controller.
 *
 * Layout: a fixed-size BaseWindow holding two views:
 *   - banner (40px): "Rocky is driving" + status + Stop. Our own static HTML,
 *     no preload; Stop works by setting location.hash, which main watches.
 *   - site (1280x800 CSS px): the booking page. Sandboxed, contextIsolation,
 *     no Node, no preload, persistent partition "persist:rocky-agent" so site
 *     logins survive, popups denied, http(s) only, every permission denied.
 *
 * Screenshots come from the site view only (capturePage, resized to the
 * 1280x800 viewport, see VIEWPORT in agentCore.cjs). Input goes in with
 * sendInputEvent / insertText in the same CSS-pixel space. DOM probes for the
 * safety gates run in an isolated world (main frame), so a page can't
 * monkey-patch elementFromPoint to sneak a final click past the gate.
 *
 * Nothing here persists screenshots or page text: they live in memory for
 * the run and go only to api.openai.com (screenshots) or the local renderer
 * (final evidence, saved in Dexie on this laptop).
 */
const { BaseWindow, WebContentsView, ipcMain, session: electronSession } = require("electron");
const core = require("./agentCore.cjs");

const BANNER_H = 40;
const ISOLATED_WORLD = 1077;
const PARTITION = "persist:rocky-agent";

const BANNER_HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;height:100%;font:13px/1 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;background:#17191a;color:#f4f3f0;overflow:hidden}
.bar{display:flex;align-items:center;gap:12px;height:100%;padding:0 14px}
.dot{width:8px;height:8px;border-radius:50%;background:#3f9e7c;animation:p 1.2s ease-in-out infinite}
@keyframes p{50%{opacity:.35}}
.k{font:600 11px/1 ui-monospace,Menlo,Consolas,monospace;letter-spacing:.08em;text-transform:uppercase}
#s{flex:1;color:#a5a29a;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
button{font:600 12px/1 ui-monospace,Menlo,Consolas,monospace;background:#f4f3f0;color:#17191a;border:0;border-radius:3px;padding:7px 14px;cursor:pointer}
button:hover{background:#3f9e7c;color:#fff}
.idle .dot{animation:none;background:#8b887f}
</style></head><body><div class="bar" id="b"><span class="dot"></span><span class="k" id="k">Rocky is driving</span><span id="s"></span><button id="x">Stop</button></div>
<script>
document.getElementById("x").onclick=function(){location.hash="stop-"+Date.now()};
window.setStatus=function(k,s,idle){document.getElementById("k").textContent=k;document.getElementById("s").textContent=s||"";document.getElementById("b").className="bar"+(idle?" idle":"")};
</script></body></html>`;

const isWeb = (url) => /^https?:\/\//i.test(String(url || ""));

// The in-page probes and settle timings are shared with the Android agent.
const {
  POINT_JS,
  FOCUS_JS,
  PROBE_JS,
  QUIET_JS,
  QUIET_MS,
  SETTLE_CAP_MS,
  NAV_CAP_MS,
  STALE_REQUEST_MS,
  SHOT_JPEG_QUALITY,
  CODE_CTX_JS,
  FOCUS_CODE_JS,
  CODE_LEN_JS,
  BOX_LEN_JS,
  MARK_FOCUSED_JS,
  MASK_CSS,
  TEXT_JS,
} = require("../shared/agentPageScripts.mjs");

/**
 * deps: { getKey() -> string|null, broadcast(event), parent() -> BrowserWindow|null }
 * options: { callModel?, limits? } (tests inject a scripted model)
 */
function createAgentController(deps, options = {}) {
  let win = null;
  let banner = null;
  let site = null;
  let run = null;
  let log = [];
  let lastPause = null;
  const inflight = new Map();

  const viewport = core.VIEWPORT;

  function setBanner(k, s, idle) {
    if (!banner || banner.webContents.isDestroyed()) return;
    banner.webContents.executeJavaScript(`window.setStatus && setStatus(${JSON.stringify(k)}, ${JSON.stringify(s || "")}, ${idle ? "true" : "false"})`).catch(() => {});
  }

  function hardenSession() {
    const ses = electronSession.fromPartition(PARTITION);
    if (ses.__rockyHardened) return ses;
    ses.__rockyHardened = true;
    // A booking page gets no camera, mic, location, notifications, or USB.
    ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
    ses.setPermissionCheckHandler(() => false);
    ses.on("will-download", (e) => e.preventDefault());
    // In-flight request tracking for settle(). Sockets, beacons and media
    // streams never "finish", so they don't count.
    const skip = new Set(["webSocket", "ping", "media", "cspReport"]);
    ses.webRequest.onBeforeRequest((d, cb) => {
      if (!skip.has(d.resourceType)) inflight.set(d.id, Date.now());
      cb({});
    });
    const drop = (d) => inflight.delete(d.id);
    ses.webRequest.onCompleted(drop);
    ses.webRequest.onErrorOccurred(drop);
    return ses;
  }

  function networkIdle() {
    const now = Date.now();
    for (const [id, t] of inflight) {
      if (now - t > 30000) inflight.delete(id); // leaked entry
      else if (now - t < STALE_REQUEST_MS) return false;
    }
    return true;
  }

  function ensureWindow(focus = true) {
    if (win && !win.isDestroyed()) return;
    hardenSession();
    const opts = {
      width: viewport.width,
      height: viewport.height + BANNER_H,
      useContentSize: true,
      resizable: false,
      maximizable: false,
      fullscreenable: false,
      title: "Rocky — booking agent",
      backgroundColor: "#17191a",
      show: false,
      autoHideMenuBar: true,
    };
    // Beside the app when there's room on screen, so both stay visible.
    const p = deps.parent && deps.parent();
    if (p && !p.isDestroyed()) {
      const b = p.getBounds();
      opts.x = b.x + b.width + 8;
      opts.y = b.y;
    }
    win = new BaseWindow(opts);
    win.setContentSize(viewport.width, viewport.height + BANNER_H);
    if (win.setMenuBarVisibility) win.setMenuBarVisibility(false);

    banner = new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: true } });
    banner.setBounds({ x: 0, y: 0, width: viewport.width, height: BANNER_H });
    banner.webContents.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(BANNER_HTML)}`);
    banner.webContents.on("will-navigate", (e) => e.preventDefault());
    banner.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    banner.webContents.on("did-navigate-in-page", (_e, url) => {
      if (/#stop-/.test(url) && run) run.cancel("Stopped from the agent window. Nothing more will be clicked.");
    });

    site = new WebContentsView({
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        partition: PARTITION,
        spellcheck: false,
      },
    });
    site.setBounds({ x: 0, y: BANNER_H, width: viewport.width, height: viewport.height });
    const wc = site.webContents;
    wc.setZoomFactor(1);
    wc.setVisualZoomLevelLimits(1, 1).catch(() => {});
    // No popups. A target=_blank http(s) link opens in this same view instead.
    wc.setWindowOpenHandler(({ url }) => {
      if (isWeb(url)) setImmediate(() => wc.loadURL(url).catch(() => {}));
      return { action: "deny" };
    });
    wc.on("will-navigate", (e, url) => {
      if (!isWeb(url)) e.preventDefault();
    });
    wc.on("will-redirect", (e, url) => {
      if (!isWeb(url)) e.preventDefault();
    });
    wc.on("will-attach-webview", (e) => e.preventDefault());

    win.contentView.addChildView(site);
    win.contentView.addChildView(banner);
    win.on("closed", () => {
      if (run) run.cancel("You closed the agent window, so the booking stopped.");
      win = null;
      banner = null;
      site = null;
    });
    if (focus) win.show();
    else win.showInactive();
  }

  const siteWc = () => {
    if (!site || site.webContents.isDestroyed()) throw new Error("The agent window was closed.");
    return site.webContents;
  };

  async function evalMain(code) {
    const wc = siteWc();
    try {
      return await wc.executeJavaScriptInIsolatedWorld(ISOLATED_WORLD, [{ code }]);
    } catch {
      return wc.executeJavaScript(code);
    }
  }

  /** Follow iframes down to the element under a point (max 3 levels). */
  async function describePoint(x, y) {
    let frame = siteWc().mainFrame;
    let px = x;
    let py = y;
    for (let depth = 0; depth < 4; depth += 1) {
      const res = depth === 0 ? await evalMain(POINT_JS(px, py)) : await frame.executeJavaScript(POINT_JS(px, py)).catch(() => null);
      if (!res || res.frame == null) return res;
      const child = frame.frames[res.frame];
      if (!child || depth === 3) return { tag: "iframe", text: "", unresolvedFrame: true };
      frame = child;
      px = Math.round(px - res.left);
      py = Math.round(py - res.top);
    }
    return null;
  }

  async function describeFocus() {
    let frame = siteWc().mainFrame;
    for (let depth = 0; depth < 4; depth += 1) {
      const res = depth === 0 ? await evalMain(FOCUS_JS) : await frame.executeJavaScript(FOCUS_JS).catch(() => null);
      if (!res || res.frame == null) return res;
      const child = frame.frames[res.frame];
      if (!child) return null;
      frame = child;
    }
    return null;
  }

  async function probe() {
    const wc = siteWc();
    const main = (await evalMain(PROBE_JS).catch(() => null)) || {};
    const frames = wc.mainFrame.framesInSubtree.filter((f) => f !== wc.mainFrame);
    const out = { url: wc.getURL(), title: wc.getTitle(), ...main };
    for (const f of frames) {
      // Same-origin and cross-origin frames both get the field scan.
      const r = await f.executeJavaScript(PROBE_JS).catch(() => null);
      if (r) for (const k of ["hasPassword", "hasCaptcha", "hasCardField", "hasTwoFactor"]) out[k] = out[k] || r[k];
    }
    return out;
  }

  /** The code field(s) and their surrounding text (main frame). */
  async function codeContext() {
    const wc = siteWc();
    const ctx = await evalMain(CODE_CTX_JS).catch(() => null);
    const base = { url: wc.getURL(), title: wc.getTitle() };
    if (ctx) return { ...base, ...ctx };
    // No field found in the DOM (e.g. inside a cross-origin frame): judge the
    // page text, which only ever makes a handoff more likely.
    const text = String((await evalMain(TEXT_JS).catch(() => "")) || "").slice(0, 1500);
    return { ...base, text, hasPassword: false, count: 0, split: false };
  }

  /**
   * Types the code into the marked field(s): masked first, then one digit per
   * box (split) or the whole code. The code is only ever an argument to
   * insertText: never in a script string, a log, or an event.
   */
  async function fillCode(code, point) {
    const wc = siteWc();
    let masked = false;
    try {
      await wc.insertCSS(MASK_CSS);
      masked = true;
    } catch {
      masked = false;
    }
    const ctx = await evalMain(CODE_CTX_JS).catch(() => null);
    if (ctx && ctx.count > 0) {
      const split = ctx.split && ctx.count >= code.length;
      const parts = split ? code.split("") : [code];
      // Focus the page once; re-focusing it per box can restore the old box.
      wc.focus();
      for (let i = 0; i < parts.length; i += 1) {
        if (!(await evalMain(FOCUS_CODE_JS(i)).catch(() => false))) return { ok: false, masked };
        await wc.insertText(parts[i]);
        // insertText can resolve before the page has it: wait for this box
        // to hold it, or the next digit lands in the same box.
        for (let t = 0; t < 15; t += 1) {
          if (Number(await evalMain(BOX_LEN_JS(i)).catch(() => -1)) >= parts[i].length) break;
          await sleep(20);
        }
      }
      // Wait for the page to hold all of it before the model clicks Verify.
      for (let t = 0; t < 20; t += 1) {
        if (Number(await evalMain(CODE_LEN_JS).catch(() => -1)) >= code.length) break;
        await sleep(50);
      }
      return { ok: true, masked };
    }
    if (!point) return { ok: false, masked };
    // The model's point: click it, and type only if that focused an input.
    for (const type of ["mouseMove", "mouseDown", "mouseUp"]) {
      wc.sendInputEvent(type === "mouseMove" ? { type, x: point.x, y: point.y } : { type, x: point.x, y: point.y, button: "left", clickCount: 1 });
      await sleep(type === "mouseUp" ? 60 : 15);
    }
    // A field inside a frame can't be marked from here: not masked.
    const marked = await evalMain(MARK_FOCUSED_JS).catch(() => false);
    if (!marked) return { ok: false, masked: false };
    wc.focus();
    await wc.insertText(code);
    return { ok: true, masked };
  }

  async function pageText() {
    const wc = siteWc();
    const parts = [String((await evalMain(TEXT_JS).catch(() => "")) || "")];
    for (const f of wc.mainFrame.framesInSubtree) {
      if (f === wc.mainFrame) continue;
      parts.push(String((await f.executeJavaScript(TEXT_JS).catch(() => "")) || ""));
    }
    return parts.join("\n").slice(0, 40000);
  }

  async function screenshot() {
    const wc = siteWc();
    // A view that hasn't painted yet throws (UnknownVizError) or returns an
    // empty image; give it a few frames.
    let img = null;
    for (let i = 0; i < 8 && !img; i += 1) {
      try {
        const c = await wc.capturePage();
        if (!c.isEmpty()) img = c;
      } catch {
        /* not painted yet */
      }
      if (!img) {
        wc.invalidate();
        await sleep(250);
      }
    }
    if (!img) throw new Error("the page hasn't drawn anything yet");
    const size = img.getSize();
    // Capture is at device pixels (e.g. 1920x1200 at 150%); the model and
    // sendInputEvent both work in the 1280x800 CSS-pixel space.
    const fit = size.width === viewport.width && size.height === viewport.height ? img : img.resize({ width: viewport.width, height: viewport.height, quality: "good" });
    const s = fit.getSize();
    // JPEG, not PNG: a photo-heavy booking page is ~1-2 MB as PNG and
    // ~150-250 KB as JPEG at q85, the same pixels and coordinates. The model
    // bills by pixel patches, not bytes, so this only cuts upload time.
    return { dataUrl: `data:image/jpeg;base64,${fit.toJPEG(SHOT_JPEG_QUALITY).toString("base64")}`, width: s.width, height: s.height };
  }

  /**
   * Pre-opened page (prepare): the first navigate of a run to the same URL
   * waits for that load instead of starting a new one.
   */
  let prepared = null;
  const PREPARED_TTL_MS = 10 * 60 * 1000;

  async function navigateRun(url) {
    const p = prepared;
    prepared = null;
    if (p && p.url === url && Date.now() - p.at < PREPARED_TTL_MS && site && !site.webContents.isDestroyed()) {
      await p.promise;
      return;
    }
    return navigate(url);
  }

  async function navigate(url) {
    if (!isWeb(url)) throw new Error("The agent opens http(s) pages only.");
    const wc = siteWc();
    await Promise.race([
      wc.loadURL(url).catch((e) => {
        // ERR_ABORTED on a client-side redirect is fine: the page still loads.
        if (!/ERR_ABORTED|\(-3\)/.test(String(e && e.message))) throw e;
      }),
      new Promise((r) => setTimeout(r, 20000)),
    ]);
  }

  /**
   * Event-based settle: done when the page isn't loading, no request is in
   * flight and the DOM has been quiet for QUIET_MS, after a short minimum
   * (so a click's fetch has started) and never longer than the cap.
   * opts: { minMs, capMs, afterType } (afterType: autocomplete needs a beat).
   */
  async function settle(opts = {}) {
    const wc = siteWc();
    const start = Date.now();
    const minMs = opts.minMs ?? (opts.afterType ? 300 : 120);
    const cap = opts.capMs ?? SETTLE_CAP_MS;
    for (;;) {
      const elapsed = Date.now() - start;
      const loading = wc.isLoading();
      if (elapsed >= (loading ? Math.max(cap, NAV_CAP_MS) : cap)) break;
      if (elapsed >= minMs && !loading && networkIdle()) {
        const quiet = await evalMain(QUIET_JS).catch(() => QUIET_MS);
        if (Number(quiet) >= QUIET_MS) break;
      } else if (elapsed < 60) {
        // Arm the observer early so the quiet clock starts with this step.
        await evalMain(QUIET_JS).catch(() => 0);
      }
      await sleep(40);
    }
  }

  async function input(step) {
    const wc = siteWc();
    if (step.insertText != null) {
      wc.focus();
      await wc.insertText(step.insertText);
      return;
    }
    const e = step.input;
    if (e.type === "keyDown" || e.type === "keyUp" || e.type === "char") wc.focus();
    wc.sendInputEvent(e);
    await sleep(e.type === "mouseUp" || e.type === "keyUp" ? 60 : 15);
  }

  async function history(dir) {
    const h = siteWc().navigationHistory;
    if (dir === "back" && h.canGoBack()) h.goBack();
    if (dir === "forward" && h.canGoForward()) h.goForward();
  }

  async function callModel(body) {
    if (options.callModel) return options.callModel(body, { site: siteWc() });
    const key = deps.getKey();
    if (!key) throw new Error("No browser key. Add it in Profile → Model.");
    for (let attempt = 0; ; attempt += 1) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 120000);
      let res;
      try {
        // browser_key goes to api.openai.com and nowhere else.
        res = await fetch(core.OPENAI_RESPONSES_URL, {
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
        msg = JSON.parse(detail).error.message;
      } catch {
        /* keep raw */
      }
      throw new Error(`OpenAI ${res.status}: ${String(msg).slice(0, 200)}`);
    }
  }

  function emit(e) {
    if (e.type === "timing") {
      const t = e.step;
      console.log(`[agent] step ${t.n}: total ${t.totalMs}ms (model ${t.modelMs}, screenshot ${t.screenshotMs}, action ${t.actionMs}, settle ${t.settleMs}, nav ${t.navMs}, shot ${t.shotKb}KB)`);
    } else if (e.timing && (e.type === "done" || e.type === "failed" || e.type === "cancelled")) {
      const s = e.timing;
      console.log(`[agent] run ${e.type}: ${s.steps} steps, ${s.totalMs}ms active, avg step ${s.avgStepMs}ms (model ${s.avgModelMs}, screenshot ${s.avgScreenshotMs}, action ${s.avgActionMs}, settle ${s.avgSettleMs}), nav total ${s.navMs}ms, slowest ${s.maxStepMs}ms`);
    }
    if (e.type === "step") {
      log.push({ n: e.n, text: e.text, blocked: Boolean(e.blocked), at: e.at });
      if (log.length > 200) log.shift();
      setBanner("Rocky is driving", e.text);
    } else if (e.type === "status") {
      setBanner(e.state === "running" ? "Rocky is driving" : "Rocky is paused", e.text, e.state !== "running");
    } else if (e.type === "code_request") {
      lastPause = { kind: "code", channel: e.channel, attempt: e.attempt };
      setBanner("Rocky is paused", "Waiting for the code the site sent you", true);
    } else if (e.type === "question") {
      lastPause = { kind: "question", question: e.question, field: e.field };
      setBanner("Rocky is paused", `Waiting for your answer: ${e.question}`, true);
    } else if (e.type === "needs_confirmation") {
      lastPause = { kind: "confirm", summary: e.summary, confirmKind: e.kind };
      setBanner("Rocky is paused", "Waiting for your yes in Rocky", true);
    } else if (e.type === "needs_user_takeover") {
      lastPause = { kind: "takeover", reason: e.reason, message: e.message };
      setBanner("Your turn", e.message, true);
    } else if (e.type === "done" || e.type === "failed" || e.type === "cancelled") {
      lastPause = null;
      setBanner(
        e.type === "done" ? (e.status === "booked" ? "Booked" : "Check the page") : e.type === "failed" ? "Stopped" : "Stopped",
        e.type === "done" ? e.reference || e.confirmationText || "" : e.reason || e.message || "",
        true,
      );
    }
    deps.broadcast(e);
  }

  const active = () => run && !["done", "failed", "cancelled"].includes(run.state);

  function state() {
    return {
      active: Boolean(active()),
      state: run ? run.state : "idle",
      pause: active() ? lastPause : null,
      log: log.slice(-50),
      task: run ? { type: run.task.type, venue: run.task.venue, date: run.task.date, time: run.task.time } : null,
    };
  }

  /**
   * Open the window and load the start page while Rocky reads the plan back.
   * Nothing is clicked or typed: the run itself still waits for the yes.
   */
  function prepare(task) {
    if (active()) return { ok: false };
    const url = core.startUrlFor(task);
    if (!isWeb(url)) return { ok: false };
    ensureWindow(false);
    if (prepared && prepared.url === url) return { ok: true };
    prepared = { url, at: Date.now(), promise: navigate(url).catch(() => {}) };
    setBanner("Rocky is ready", "Opened the booking page. Waiting for your yes.", true);
    return { ok: true };
  }

  async function start(task) {
    if (active()) return { error: "A booking is already running. Stop it first." };
    if (!options.callModel && !deps.getKey()) return { error: "No browser key. Add it in Profile → Model." };
    ensureWindow();
    // A window pre-opened without focus (prepare) comes forward now: an
    // unfocused page can hold typed text back until the next input event.
    if (win && !win.isDestroyed() && !win.isFocused()) win.show();
    log = [];
    lastPause = null;
    run = new core.BookingRun(
      task,
      { callModel, screenshot, navigate: navigateRun, history, input, settle, probe, describePoint, describeFocus, pageText, codeContext, fillCode, emit, now: () => Date.now(), sleep },
      { limits: options.limits },
    );
    void run.start();
    return { ok: true };
  }

  return {
    start,
    prepare,
    answer: (text) => Boolean(run && run.answer(text)),
    /** The verification code: straight into the run, never logged. */
    submitCode: async (text) => (run ? run.submitCode(text) : { ok: false, error: "not_waiting" }),
    confirm: (yes) => Boolean(run && run.confirm(yes === true)),
    continueRun: () => Boolean(run && run.continueRun()),
    cancel: () => Boolean(run && run.cancel()),
    state,
    current: () => run,
    site: () => site,
    window: () => win,
  };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** IPC surface for the renderer. Every handler validates its input. */
function registerAgentIpc(controller) {
  ipcMain.handle("agent:available", () => true);
  ipcMain.handle("agent:start", (_e, task) => controller.start(task && typeof task === "object" ? task : {}));
  ipcMain.handle("agent:prepare", (_e, task) => controller.prepare(task && typeof task === "object" ? task : {}));
  ipcMain.handle("agent:answer", (_e, text) => controller.answer(String(text ?? "").slice(0, 500)));
  // Its own channel so the code never shares a path with ordinary answers.
  ipcMain.handle("agent:code", (_e, text) => controller.submitCode(String(text ?? "").slice(0, 120)));
  ipcMain.handle("agent:confirm", (_e, yes) => controller.confirm(yes === true));
  ipcMain.handle("agent:continue", () => controller.continueRun());
  ipcMain.handle("agent:cancel", () => controller.cancel());
  ipcMain.handle("agent:state", () => controller.state());
}

module.exports = { createAgentController, registerAgentIpc, BANNER_H, PARTITION };
