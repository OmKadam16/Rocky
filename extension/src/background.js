// Rocky Memory: background service worker.
//
// Captures a page when a tab finishes loading, but only when the user has
// granted access to that site (optional host permission, asked in the popup)
// and the page isn't excluded. No content script runs anywhere by default;
// the extractor below is injected with chrome.scripting only into allowed
// pages. Pages go to Rocky's local server on 127.0.0.1 and nowhere else.
import { DEFAULT_PORT, cleanText, enqueue, originPattern, seenRecently, shouldCapture, visitSeconds } from "./lib.js";
import { extractPage } from "./extract.js";

const get = (keys) => chrome.storage.local.get(keys);
const set = (obj) => chrome.storage.local.set(obj);

async function config() {
  const c = await get(["token", "port", "paused", "excluded", "remoteExcluded"]);
  return {
    token: c.token || "",
    port: Number(c.port) || DEFAULT_PORT,
    paused: Boolean(c.paused),
    excluded: [...(c.excluded || []), ...(c.remoteExcluded || [])],
  };
}

const server = (port) => `http://127.0.0.1:${port}`;

async function sha(s) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].slice(0, 12).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function post(item, route = "/ingest") {
  const c = await config();
  if (!c.token) return { ok: false, reason: "not_connected" };
  let res;
  try {
    res = await fetch(`${server(c.port)}${route}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${c.token}`, "Content-Type": "application/json", "X-Rocky-Extension": chrome.runtime.id },
      body: JSON.stringify(item),
    });
  } catch {
    if (route !== "/ingest") return { ok: false, reason: "offline" }; // time on page isn't worth queueing
    // Rocky isn't running: keep a few items and retry later.
    const { queue = [] } = await get(["queue"]);
    await set({ queue: enqueue(queue, item) });
    return { ok: false, reason: "queued" };
  }
  if (res.status === 401) {
    await set({ connected: false });
    return { ok: false, reason: "not_paired" };
  }
  if (res.status >= 500 && route === "/ingest") {
    const { queue = [] } = await get(["queue"]);
    await set({ queue: enqueue(queue, item) });
    return { ok: false, reason: "queued" };
  }
  const body = await res.json().catch(() => ({}));
  if (route === "/ingest" && body.ok && !body.deduped) {
    const { saved = 0 } = await get(["saved"]);
    await set({ saved: saved + 1, connected: true });
  }
  return body.ok ? { ok: true } : { ok: false, reason: body.reason || "rejected" };
}

async function capture(tab, { manual = false, screenshot = null } = {}) {
  if (!tab || tab.incognito || !tab.id) return { ok: false, reason: "incognito" };
  const c = await config();
  if (!c.token) return { ok: false, reason: "not_connected" };
  if (!manual && c.paused) return { ok: false, reason: "paused" };
  if (!shouldCapture(tab.url, c.excluded)) return { ok: false, reason: "excluded" };
  if (!manual) {
    const origin = originPattern(tab.url);
    if (!origin || !(await chrome.permissions.contains({ origins: [origin] }))) return { ok: false, reason: "no_access" };
  }
  let page;
  try {
    const [r] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: extractPage });
    page = r && r.result;
  } catch {
    return { ok: false, reason: "blocked" };
  }
  if (!page || page.skip) return { ok: false, reason: (page && page.skip) || "empty" };
  if (!shouldCapture(page.url, c.excluded)) return { ok: false, reason: "excluded" };
  const text = cleanText(page.text);
  const key = `${page.url}#${await sha(`${page.title}\n${text}`)}`;
  const { recent } = await get(["recent"]);
  const s = seenRecently(recent, key);
  if (s.seen && !manual) return { ok: true, reason: "duplicate" };
  await set({ recent: { ...s.recent, [key]: Date.now() } });
  // "Save this page" is pinned in Rocky (and may carry a thumbnail).
  return post({ url: page.url, title: page.title, text, ...(manual ? { manual: true } : {}), ...(screenshot ? { screenshot } : {}) });
}

// ---- time on page ------------------------------------------------------------
// Only the active tab of the focused window counts. A segment starts when a
// saved site becomes active and ends on switching away, navigating, closing
// or losing focus; Rocky adds the seconds to that page's memory.

async function endSegment() {
  const { active } = await chrome.storage.session.get(["active"]);
  if (!active) return;
  await chrome.storage.session.remove("active");
  const seconds = visitSeconds(active.since);
  if (seconds) await post({ url: active.url, seconds }, "/visit");
}

async function beginSegment(tab) {
  await endSegment();
  if (!tab || tab.incognito || !tab.id || !tab.url) return;
  const c = await config();
  if (!c.token || c.paused || !shouldCapture(tab.url, c.excluded)) return;
  const origin = originPattern(tab.url);
  if (!origin || !(await chrome.permissions.contains({ origins: [origin] }))) return;
  await chrome.storage.session.set({ active: { tabId: tab.id, url: tab.url, since: Date.now() } });
}

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.status === "complete") {
    void capture({ ...tab, id: tabId });
    if (tab.active) void beginSegment({ ...tab, id: tabId });
  }
});
chrome.tabs.onActivated.addListener(({ tabId }) => {
  void chrome.tabs.get(tabId).then(beginSegment, () => endSegment());
});
chrome.tabs.onRemoved.addListener((tabId) => {
  void chrome.storage.session.get(["active"]).then(({ active }) => {
    if (active && active.tabId === tabId) void endSegment();
  });
});
chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) void endSegment();
  else void chrome.tabs.query({ active: true, windowId }).then(([tab]) => beginSegment(tab));
});

async function flushQueue() {
  const { queue = [] } = await get(["queue"]);
  if (!queue.length) return;
  await set({ queue: [] });
  for (const item of queue) {
    const { queuedAt: _q, ...rest } = item;
    void _q;
    const r = await post(rest);
    if (r.reason === "queued") break; // still offline: post() re-queued it
  }
}

chrome.alarms.create("rocky-retry", { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === "rocky-retry") void flushQueue();
});

async function status() {
  const c = await config();
  const local = await get(["saved", "queue"]);
  const base = { connected: false, paused: c.paused, port: c.port, saved: local.saved || 0, queued: (local.queue || []).length, hasToken: Boolean(c.token) };
  if (!c.token) return base;
  try {
    const r = await fetch(`${server(c.port)}/status`, { headers: { Authorization: `Bearer ${c.token}`, "X-Rocky-Extension": chrome.runtime.id } });
    if (!r.ok) {
      const why =
        r.status === 401
          ? "Token doesn't match — paste the one from Rocky's Memory page."
          : r.status === 403
            ? `Rocky didn't recognise this extension (id ${chrome.runtime.id}). Reload it from extension/dist.`
            : `Rocky refused the connection (${r.status}).`;
      return { ...base, error: why };
    }
    const j = await r.json();
    await set({ remoteExcluded: j.excluded || [], connected: true });
    return { ...base, connected: true, appEnabled: j.enabled, appPaused: j.paused, count: j.count };
  } catch {
    return { ...base, error: "Rocky isn't running (or Memory is off)." };
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  (async () => {
    switch (msg && msg.type) {
      case "status":
        return status();
      case "connect":
        await set({ token: String(msg.token || "").trim(), port: Number(msg.port) || DEFAULT_PORT });
        return status();
      case "set-paused":
        await set({ paused: Boolean(msg.paused) });
        return status();
      case "save-now": {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        let screenshot = null;
        if (msg.screenshot) {
          try {
            screenshot = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "jpeg", quality: 60 });
          } catch {
            screenshot = null;
          }
        }
        return capture(tab, { manual: true, screenshot });
      }
      case "exclude-site": {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        const host = tab && tab.url ? new URL(tab.url).hostname.replace(/^www\./, "") : "";
        if (!host) return { ok: false };
        const { excluded = [] } = await get(["excluded"]);
        await set({ excluded: [...new Set([...excluded, host])] });
        return { ok: true, host };
      }
      default:
        return { ok: false };
    }
  })().then(reply, () => reply({ ok: false }));
  return true;
});
