"use strict";
/**
 * Memory wiring in the Electron main process: the store in userData, the
 * 127.0.0.1 ingest server (running only while Memory is on), the background
 * gist worker, the monthly compactor, and a small IPC API for the Memory page
 * and the chat. Memory content goes to the renderer of this app and nowhere
 * else: never Supabase, never a cloud model, never the phone relay, never a
 * log. Models (Ollama) are only used while Memory is on.
 */
const { app, ipcMain, shell } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { createMemoryStore, monthKey } = require("./memoryStore.cjs");
const { createMemoryServer, EXTENSION_ID } = require("./memoryServer.cjs");
const { answerQuestion, ollamaChat } = require("./memoryAnswer.cjs");
const { createVectorIndex, ollamaEmbed, EMBED_MODEL } = require("./memoryVectors.cjs");
const { createMemoryWorker } = require("./memoryWorker.cjs");
const { createCompactor } = require("./memoryCompact.cjs");

/** The app says when the user is mid-turn or a booking run is going. */
const BUSY_STALE_MS = 2 * 60 * 1000;

function registerMemory() {
  const dir = path.join(app.getPath("userData"), "memory");
  fs.mkdirSync(dir, { recursive: true });
  const store = createMemoryStore({ file: path.join(dir, "memory.db"), shotsDir: path.join(dir, "thumbs") });
  const index = createVectorIndex();
  let server = null;
  let serverError = null;
  let busy = { on: false, at: 0 };
  /** Last timings only (numbers), for the debug readout. Never content. */
  const timings = { gist_ms: null, embed_ms: null, compaction_ms: null };

  // One local-model user at a time: a chat answer, the worker, or compaction.
  let modelBusy = 0;
  const lockedChat = async (req) => {
    modelBusy += 1;
    try {
      return await ollamaChat(req);
    } finally {
      modelBusy -= 1;
    }
  };
  const isBusy = () => (busy.on && Date.now() - busy.at < BUSY_STALE_MS) || modelBusy > 0;

  const worker = createMemoryWorker({
    store,
    index,
    chat: lockedChat,
    embed: (texts) => ollamaEmbed(texts),
    isBusy,
    onTiming: (t) => {
      timings.gist_ms = t.gist_ms;
      timings.embed_ms = t.embed_ms;
    },
  });
  const compactor = createCompactor({
    store,
    index,
    chat: lockedChat,
    embed: (texts) => ollamaEmbed(texts),
    isBusy,
    onTiming: (t) => {
      timings.compaction_ms = t.compaction_ms;
    },
  });
  worker.loadIndex();

  async function sync() {
    const s = store.settings();
    if (s.enabled && (!server || server.port() !== s.port)) {
      if (server) await server.stop();
      server = createMemoryServer({ store, port: s.port });
      try {
        await server.start();
        serverError = null;
      } catch (e) {
        server = null;
        serverError = e && e.code === "EADDRINUSE" ? `Port ${s.port} is already in use. Pick another port.` : "The Memory server couldn't start.";
      }
    } else if (!s.enabled && server) {
      await server.stop();
      server = null;
    }
    if (s.enabled) worker.start();
    else worker.stop();
  }

  function status() {
    const s = store.settings();
    const all = store.compactions().filter((c) => c.status === "done" && c.entries > 0);
    const last = all[0] || null;
    return {
      available: true,
      settings: s,
      stats: store.stats(),
      server: { running: Boolean(server && server.running()), port: s.port, error: serverError },
      extensionId: EXTENSION_ID,
      embedModel: EMBED_MODEL,
      search: worker.status().embedOk === false ? "keyword" : index.size() ? "hybrid" : "keyword",
      lastCompaction: last,
      lastRun: store.kvGet("last_compaction_run"),
      nextCompaction: compactor.nextCompaction(),
      undoable: store.undoableMonths(),
      timings,
    };
  }

  /** Months for browsing: the current month's entries + each compacted month. */
  function months() {
    const rows = store.memoriesWhere({ limit: 100000 });
    const by = new Map();
    for (const m of rows) {
      const k = m.month;
      const x = by.get(k) || { month: k, detail: 0, digests: 0, overviews: 0 };
      if (m.tier === 0) x.detail += 1;
      else if (m.tier === 1) x.digests += 1;
      else x.overviews += 1;
      by.set(k, x);
    }
    return [...by.values()]
      .map((x) => ({ ...x, compaction: store.compaction(x.month), current: x.month === monthKey(Date.now()) }))
      .sort((a, b) => (a.month < b.month ? 1 : -1));
  }

  async function runCompaction(opts) {
    if (!store.settings().enabled) return { off: true };
    try {
      return await compactor.run(opts);
    } catch {
      return { error: true };
    }
  }

  void sync();
  // Compaction at start (after the app settles) and once a day.
  const startRun = setTimeout(() => void runCompaction(), 60 * 1000);
  startRun.unref?.();
  const daily = setInterval(() => void runCompaction(), 24 * 60 * 60 * 1000);
  daily.unref?.();

  ipcMain.handle("memory:status", () => status());
  ipcMain.handle("memory:set", async (_e, patch) => {
    const p = patch && typeof patch === "object" ? patch : {};
    const allowed = {};
    for (const k of ["enabled", "paused", "excluded", "sizeCapMB", "keepShrinking", "port", "rotateToken"]) if (k in p) allowed[k] = p[k];
    store.setSettings(allowed);
    await sync();
    return status();
  });
  ipcMain.handle("memory:months", () => months());
  ipcMain.handle("memory:list", (_e, opts) => {
    const o = opts && typeof opts === "object" ? opts : {};
    const month = typeof o.month === "string" && /^\d{4}(-\d{2})?$/.test(o.month) ? o.month : null;
    const q = String(o.q || "").trim().toLowerCase();
    let rows = store.memoriesWhere({ month, limit: Math.min(500, Number(o.limit) || 200), offset: Number(o.offset) || 0 });
    if (q) rows = rows.filter((m) => `${m.title} ${m.gist} ${m.topics.join(" ")} ${m.domains.join(" ")}`.toLowerCase().includes(q));
    // What the page shows: never raw text (there is none), no vectors.
    return rows.map((m) => ({
      id: m.id, tier: m.tier, kind: m.kind, title: m.title, gist: m.gist, keyPoints: m.key_points, topics: m.topics,
      urls: m.urls.slice(0, 12), domains: m.domains, firstSeen: m.first_seen, lastSeen: m.last_seen, visits: m.visit_count,
      minutes: Math.round(m.minutes), pinned: m.pinned, importance: m.importance, month: m.month,
      sources: m.meta.sources || [], highlights: (m.meta.highlights || []).map((h) => ({ title: h.title, gist: h.gist, url: h.url, date: h.date })),
      entries: m.meta.entries || null, paper: m.meta.paper || null,
    }));
  });
  ipcMain.handle("memory:delete", (_e, id) => {
    store.deleteMemories([Number(id)]);
    index.delete(Number(id));
    return true;
  });
  ipcMain.handle("memory:deleteMonth", (_e, month) => {
    if (typeof month !== "string" || !/^\d{4}(-\d{2})?$/.test(month)) return false;
    const ids = store.memoriesWhere({ month, limit: 100000 }).map((m) => m.id);
    store.deleteMemories(ids);
    ids.forEach((id) => index.delete(id));
    return true;
  });
  ipcMain.handle("memory:pin", (_e, id, pinned) => store.updateMemory(Number(id), { pinned: pinned === true }));
  ipcMain.handle("memory:clear", () => {
    store.clear();
    index.clear();
    return true;
  });
  ipcMain.handle("memory:compactNow", () => runCompaction({ includeUndone: true }));
  ipcMain.handle("memory:undo", (_e, month) => (typeof month === "string" ? compactor.undoMonth(month) : { ok: false }));
  ipcMain.handle("memory:busy", (_e, on) => {
    busy = { on: on === true, at: Date.now() };
    return true;
  });
  ipcMain.handle("memory:ask", (_e, question) =>
    answerQuestion(String(question ?? "").slice(0, 500), { store, index, chat: lockedChat, embed: (t) => ollamaEmbed(t) }),
  );
  ipcMain.handle("memory:open", (_e, url) => {
    const u = String(url ?? "");
    if (/^https?:\/\//i.test(u)) void shell.openExternal(u);
    return true;
  });

  app.on("before-quit", () => {
    clearInterval(daily);
    clearTimeout(startRun);
    worker.stop();
    void server?.stop();
    try {
      store.close();
    } catch {
      /* already closed */
    }
  });
  return { store, sync, status };
}

module.exports = { registerMemory };
