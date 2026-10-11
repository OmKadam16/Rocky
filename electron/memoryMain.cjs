"use strict";
/**
 * Memory wiring in the Electron main process: the store in userData, the
 * 127.0.0.1 ingest server (running only while Memory is on), and a small IPC
 * API for the Memory page and the chat. Memory content goes to the renderer
 * of this app and nowhere else: never Supabase, never a cloud model, never
 * the phone relay, never a log.
 */
const { app, ipcMain, shell } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { createMemoryStore } = require("./memoryStore.cjs");
const { createMemoryServer, EXTENSION_ID } = require("./memoryServer.cjs");
const { answerQuestion } = require("./memoryAnswer.cjs");

function registerMemory() {
  const dir = path.join(app.getPath("userData"), "memory");
  fs.mkdirSync(dir, { recursive: true });
  const store = createMemoryStore({ file: path.join(dir, "memory.db"), shotsDir: path.join(dir, "shots") });
  let server = null;
  let serverError = null;

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
  }

  function status() {
    const s = store.settings();
    return {
      available: true,
      settings: s,
      stats: store.stats(),
      server: { running: Boolean(server && server.running()), port: s.port, error: serverError },
      extensionId: EXTENSION_ID,
    };
  }

  void sync();
  const daily = setInterval(() => {
    try {
      store.prune();
    } catch {
      /* next time */
    }
  }, 6 * 60 * 60 * 1000);
  daily.unref?.();

  ipcMain.handle("memory:status", () => status());
  ipcMain.handle("memory:set", async (_e, patch) => {
    const p = patch && typeof patch === "object" ? patch : {};
    const allowed = {};
    for (const k of ["enabled", "paused", "excluded", "retentionDays", "sizeCapMB", "port", "rotateToken"]) if (k in p) allowed[k] = p[k];
    store.setSettings(allowed);
    await sync();
    return status();
  });
  ipcMain.handle("memory:list", (_e, opts) => store.list(opts && typeof opts === "object" ? opts : {}));
  ipcMain.handle("memory:delete", (_e, id) => store.remove(Number(id)));
  ipcMain.handle("memory:clear", () => {
    store.clear();
    return true;
  });
  ipcMain.handle("memory:ask", (_e, question) => answerQuestion(String(question ?? "").slice(0, 500), { store }));
  ipcMain.handle("memory:open", (_e, url) => {
    const u = String(url ?? "");
    if (/^https?:\/\//i.test(u)) void shell.openExternal(u);
    return true;
  });

  app.on("before-quit", () => {
    clearInterval(daily);
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
