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
  browser: {
    /** False in a plain browser — the planner then hands over a link instead. */
    available: () => ipcRenderer.invoke("browser:available"),
    open: () => ipcRenderer.invoke("browser:open"),
    navigate: (url) => ipcRenderer.invoke("browser:navigate", url),
    snapshot: () => ipcRenderer.invoke("browser:snapshot"),
    click: (selector) => ipcRenderer.invoke("browser:click", selector),
    type: (selector, text) => ipcRenderer.invoke("browser:type", selector, text),
    close: () => ipcRenderer.invoke("browser:close"),
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
