"use strict";
/**
 * The only bridge between the renderer and Node. Everything else stays sandboxed.
 */
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("rocky", {
  isDesktop: true,
  platform: process.platform,
  secrets: {
    /** True when the OS keychain is usable for encryption. */
    available: () => ipcRenderer.invoke("secrets:available"),
    get: (name) => ipcRenderer.invoke("secrets:get", name),
    set: (name, value) => ipcRenderer.invoke("secrets:set", name, value),
  },
  updates: {
    current: () => ipcRenderer.invoke("update:version"),
    check: () => ipcRenderer.invoke("update:check"),
    download: () => ipcRenderer.invoke("update:download"),
    install: () => ipcRenderer.invoke("update:install"),
    /** Check on start + every 6 h and download in the background (restart still asks). */
    auto: (on) => ipcRenderer.invoke("update:auto", on === true),
    /** Subscribe to progress; returns an unsubscribe function. */
    onState: (handler) => {
      const listener = (_event, payload) => handler(payload);
      ipcRenderer.on("update:state", listener);
      return () => ipcRenderer.removeListener("update:state", listener);
    },
  },
  power: {
    /** Ask the OS not to suspend Rocky while a phone is paired. */
    keepAwake: (on) => ipcRenderer.invoke("power:keepAwake", on === true),
    /** Called after the computer wakes from sleep; returns an unsubscribe function. */
    onResume: (handler) => {
      const listener = () => handler();
      ipcRenderer.on("power:resume", listener);
      return () => ipcRenderer.removeListener("power:resume", listener);
    },
  },
  shell: {
    openExternal: (url) => ipcRenderer.invoke("shell:openExternal", url),
  },
  voice: {
    /** Desktop only: transcription runs in main (the renderer upload path kept failing). Absent in browsers. */
    transcribe: (args) => ipcRenderer.invoke("voice:transcribe", args),
  },
  agent: {
    /** Only defined on desktop: the planner hands over a link everywhere else. */
    available: () => ipcRenderer.invoke("agent:available"),
    start: (task) => ipcRenderer.invoke("agent:start", task),
    /** Pre-open the start page during the read-back. Never acts on it. */
    prepare: (task) => ipcRenderer.invoke("agent:prepare", task),
    answer: (text) => ipcRenderer.invoke("agent:answer", text),
    /** A one-time booking code: goes straight to the run (main process). */
    code: (text) => ipcRenderer.invoke("agent:code", text),
    confirm: (yes) => ipcRenderer.invoke("agent:confirm", yes === true),
    continue: () => ipcRenderer.invoke("agent:continue"),
    cancel: () => ipcRenderer.invoke("agent:cancel"),
    state: () => ipcRenderer.invoke("agent:state"),
    /** Subscribe to run events; returns an unsubscribe function. */
    onEvent: (handler) => {
      const listener = (_event, payload) => handler(payload);
      ipcRenderer.on("agent:event", listener);
      return () => ipcRenderer.removeListener("agent:event", listener);
    },
  },
  memory: {
    /** Local Memory (Electron main only): settings, saved pages, questions. */
    status: () => ipcRenderer.invoke("memory:status"),
    set: (patch) => ipcRenderer.invoke("memory:set", patch),
    list: (opts) => ipcRenderer.invoke("memory:list", opts),
    months: () => ipcRenderer.invoke("memory:months"),
    remove: (id) => ipcRenderer.invoke("memory:delete", id),
    removeMonth: (month) => ipcRenderer.invoke("memory:deleteMonth", month),
    pin: (id, pinned) => ipcRenderer.invoke("memory:pin", id, pinned === true),
    compactNow: () => ipcRenderer.invoke("memory:compactNow"),
    undo: (month) => ipcRenderer.invoke("memory:undo", month),
    /** The user is mid-turn or a booking run is going: the background worker waits. */
    busy: (on) => ipcRenderer.invoke("memory:busy", on === true),
    clear: () => ipcRenderer.invoke("memory:clear"),
    ask: (question) => ipcRenderer.invoke("memory:ask", question),
    open: (url) => ipcRenderer.invoke("memory:open", url),
  },
  ollama: {
    installOfficial: (platform) => ipcRenderer.invoke("ollama:installOfficial", platform),
    onInstallProgress: (handler) => {
      const listener = (_event, payload) => handler(payload);
      ipcRenderer.on("ollama:install-progress", listener);
      return () => ipcRenderer.removeListener("ollama:install-progress", listener);
    },
  },
});
