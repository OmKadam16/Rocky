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
    /** Subscribe to progress; returns an unsubscribe function. */
    onState: (handler) => {
      const listener = (_event, payload) => handler(payload);
      ipcRenderer.on("update:state", listener);
      return () => ipcRenderer.removeListener("update:state", listener);
    },
  },
  shell: {
    openExternal: (url) => ipcRenderer.invoke("shell:openExternal", url),
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
  ollama: {
    installOfficial: (platform) => ipcRenderer.invoke("ollama:installOfficial", platform),
    onInstallProgress: (handler) => {
      const listener = (_event, payload) => handler(payload);
      ipcRenderer.on("ollama:install-progress", listener);
      return () => ipcRenderer.removeListener("ollama:install-progress", listener);
    },
  },
});
