"use strict";
/**
 * Rocky Calendar — Electron main process.
 *
 * The renderer is served over a custom `app://` scheme rather than `file://`.
 * A file:// page has an opaque (null) origin, which breaks CORS calls to
 * api.openai.com / api.elevenlabs.io and makes mic permission prompts
 * unpredictable. `app://rocky` behaves like a normal secure origin.
 */
const { app, BrowserWindow, ipcMain, net, powerMonitor, powerSaveBlocker, protocol, safeStorage, shell, systemPreferences } = require("electron");
const { autoUpdater } = require("electron-updater");
const path = require("node:path");
const fs = require("node:fs");
const { pathToFileURL } = require("node:url");

// Packaged builds take this from Info.plist, but an unpackaged `electron .`
// would otherwise call itself "Electron" in the menu bar and userData path.
app.setName("Rocky");

const DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL || null;
const DIST = path.join(__dirname, "..", "dist");
const APP_ORIGIN = "app://rocky";

// Must be declared before `app.ready` for the scheme to be treated as secure.
protocol.registerSchemesAsPrivileged([
  {
    scheme: "app",
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
  },
]);

/** True only when `target` is the directory itself or genuinely inside it. */
function contains(dir, target) {
  const rel = path.relative(dir, target);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** Serve the Vite build, falling back to index.html so client routing works. */
function registerAppProtocol() {
  protocol.handle("app", async (request) => {
    const { pathname } = new URL(request.url);
    const relative = decodeURIComponent(pathname).replace(/^\/+/, "");
    let target = path.join(DIST, relative);

    // path.relative, not startsWith: a prefix match would accept a sibling
    // directory whose name merely begins with "dist".
    if (!contains(DIST, target)) return new Response("Forbidden", { status: 403 });
    if (!relative || !fs.existsSync(target) || fs.statSync(target).isDirectory()) {
      target = path.join(DIST, "index.html");
    }
    return net.fetch(pathToFileURL(target).toString());
  });
}

/**
 * Hand a link to the OS browser — but only a web link.
 *
 * shell.openExternal will launch anything the system has a handler for,
 * including file:// and third-party custom schemes. The assistant renders
 * model-generated text, so the URL here is not always ours.
 * Only http(s) and mailto get out.
 */
function openExternally(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return;
  }
  if (parsed.protocol === "http:" || parsed.protocol === "https:" || parsed.protocol === "mailto:") {
    void shell.openExternal(parsed.toString());
  } else {
    console.warn("[rocky] refused to open non-web URL:", parsed.protocol);
  }
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 1100,
    minHeight: 820,
    // Native macOS titlebar, with the traffic lights inset over the app's own chrome.
    titleBarStyle: "hiddenInset",
    backgroundColor: "#0E0F10",
    // Windows and Linux read the window icon from here; macOS uses the bundle.
    icon: path.join(__dirname, "..", "build", "icon.png"),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      // The preload requires nothing but "electron", which sandboxed preloads
      // still provide — so the renderer process gets the OS sandbox too.
      sandbox: true,
      // Keep timers running while minimized or hidden: the 15 s presence
      // heartbeat and the Supabase realtime relay must not be throttled, or
      // the phone sees the laptop as offline.
      backgroundThrottling: false,
    },
  });

  win.once("ready-to-show", () => win.show());

  win.webContents.on("did-finish-load", () => console.log("[rocky] renderer loaded"));
  win.webContents.on("did-fail-load", (_event, code, description, url) =>
    console.error(`[rocky] load failed ${code} ${description} ${url}`),
  );

  // External links open in the real browser, never inside the app shell.
  // Nothing may navigate this window off our own origin.
  win.webContents.on("will-navigate", (event, url) => {
    const allowed = url.startsWith(APP_ORIGIN) || (DEV_SERVER_URL && url.startsWith(DEV_SERVER_URL));
    if (!allowed) {
      event.preventDefault();
      openExternally(url);
    }
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternally(url);
    return { action: "deny" };
  });

  if (DEV_SERVER_URL) {
    void win.loadURL(DEV_SERVER_URL);
  } else {
    void win.loadURL(`${APP_ORIGIN}/index.html`);
  }
  return win;
}

/**
 * Content-Security-Policy for the packaged app.
 *
 * The user's own API key lives in this renderer, so the thing to prevent is a
 * bug turning into an exfiltration path: scripts may only come from the bundle,
 * and the page may only talk to the two API hosts it actually needs.
 *
 * Applied as a header rather than a meta tag so the Vite dev server (websockets,
 * eval-based HMR) is unaffected.
 */
const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  // React writes inline style attributes; Tailwind ships a stylesheet.
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com data:",
  "img-src 'self' data: blob:",
  // Speech playback is fed from blob URLs.
  "media-src 'self' blob:",
  "connect-src 'self' https://api.openai.com https://api.elevenlabs.io https://generativelanguage.googleapis.com https://api.anthropic.com https://api.x.ai https://*.supabase.co wss://*.supabase.co http://localhost:11434",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

function applyCsp(session) {
  session.webRequest.onHeadersReceived((details, callback) => {
    // Dev server responses are left alone; HMR needs eval and a websocket.
    if (DEV_SERVER_URL && details.url.startsWith(DEV_SERVER_URL)) {
      callback({ responseHeaders: details.responseHeaders });
      return;
    }
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [CSP],
      },
    });
  });
}

/** Grant the microphone to our own origin only. */
function configurePermissions(session) {
  session.setPermissionRequestHandler((contents, permission, callback) => {
    const url = contents.getURL();
    const ours = url.startsWith(APP_ORIGIN) || (DEV_SERVER_URL && url.startsWith(DEV_SERVER_URL));
    callback(Boolean(ours) && (permission === "media" || permission === "audioCapture"));
  });
}

// ---------------------------------------------------------------------------
// Secrets: API keys encrypted with the macOS Keychain via safeStorage.
// ---------------------------------------------------------------------------
const secretsFile = () => path.join(app.getPath("userData"), "secrets.json");

/** The only names the renderer may read or write. */
const SECRET_NAMES = new Set(["llm_key", "el_key", "browser_key"]);

function readSecrets() {
  try {
    // Null prototype: the store is keyed by renderer-supplied strings, and a
    // plain object would let "__proto__" or "constructor" mean something.
    return Object.assign(Object.create(null), JSON.parse(fs.readFileSync(secretsFile(), "utf8")));
  } catch {
    return Object.create(null);
  }
}

function writeSecrets(store) {
  const file = secretsFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(store), { mode: 0o600 });
  // `mode` only applies when the file is created; enforce it on rewrites too.
  try { fs.chmodSync(file, 0o600); } catch { /* best effort */ }
}

function registerSecretHandlers() {
  ipcMain.handle("secrets:available", () => safeStorage.isEncryptionAvailable());

  ipcMain.handle("secrets:get", (_event, name) => {
    if (!SECRET_NAMES.has(String(name))) return null;
    if (!safeStorage.isEncryptionAvailable()) return null;
    const stored = readSecrets()[String(name)];
    if (!stored) return null;
    try {
      return safeStorage.decryptString(Buffer.from(stored, "base64"));
    } catch {
      return null;
    }
  });

  ipcMain.handle("secrets:set", (_event, name, value) => {
    if (!SECRET_NAMES.has(String(name))) return false;
    if (!safeStorage.isEncryptionAvailable()) return false;
    const store = readSecrets();
    const key = String(name);
    if (value == null || value === "") delete store[key];
    else store[key] = safeStorage.encryptString(String(value)).toString("base64");
    writeSecrets(store);
    return true;
  });
}

// ---------------------------------------------------------------------------
// Booking Agent v2 (agentWindow.cjs + agentCore.cjs): the GPT-5.5 computer-use
// loop runs here in main, next to the keychain. The renderer only gets a small
// start/answer/confirm/continue/cancel API plus events.
// ---------------------------------------------------------------------------
function readBrowserKey() {
  if (!safeStorage.isEncryptionAvailable()) return null;
  const stored = readSecrets().browser_key;
  if (!stored) return null;
  try {
    return safeStorage.decryptString(Buffer.from(stored, "base64")).trim() || null;
  } catch {
    return null;
  }
}

function registerBrowserHandlers() {
  const { createAgentController, registerAgentIpc } = require("./agentWindow.cjs");
  const controller = createAgentController({
    getKey: readBrowserKey,
    parent: () => BrowserWindow.getAllWindows()[0] || null,
    broadcast: (event) => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.send("agent:event", event);
      }
    },
  });
  registerAgentIpc(controller);
}

// ---------------------------------------------------------------------------
// Updates. The renderer drives this with a button, so nothing downloads on its
// own — we only check when asked, then wait for a second explicit "download".
//
// NOTE: on macOS the install step runs through Squirrel.Mac, which refuses to
// apply an update to an app that is not code-signed. Everything up to and
// including the download works unsigned; quitAndInstall will fail until the
// build is signed and notarised, and the renderer surfaces that error rather
// than pretending it worked.
// ---------------------------------------------------------------------------
function explain(err) {
  const raw = String((err && err.stack) || (err && err.message) || err || "");
  console.error("[rocky] updater error:", raw);

  if (/404/.test(raw)) return "No published releases yet — nothing to update to.";
  if (/ENOTFOUND|EAI_AGAIN|ENETUNREACH|ETIMEDOUT/i.test(raw)) return "Couldn't reach the update server.";
  if (/code ?signature|not signed|rejected by|publisherName|signed by/i.test(raw)) {
    return process.platform === "win32"
      ? "Windows refused the update because Rocky isn't code-signed. Download the new installer from the releases page and run it (choose More info → Run anyway if SmartScreen asks)."
      : "This build isn't code-signed, so macOS won't install the update.";
  }
  if (/sha512|checksum/i.test(raw)) return "The download didn't match its checksum.";

  const first = raw.split("\n")[0].trim();
  return first.length > 120 ? first.slice(0, 120) + "…" : first || "Update check failed.";
}

function isAllowedOllamaUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && u.hostname === "ollama.com" && u.pathname.startsWith("/download");
  } catch {
    return false;
  }
}

// Hardcoded official installers — the renderer may only pass the platform.
const OLLAMA_INSTALL_URLS = {
  win32: "https://ollama.com/download/OllamaSetup.exe",
  darwin: "https://ollama.com/download/Ollama-darwin.zip",
};
const OLLAMA_INSTALL_NAMES = { win32: "OllamaSetup.exe", darwin: "Ollama-darwin.zip" };
const OLLAMA_REDIRECT_HOSTS = new Set(["ollama.com", "github.com", "objects.githubusercontent.com"]);

function downloadToFile(startUrl, target, onProgress) {
  const https = require("node:https");
  return new Promise((resolve, reject) => {
    let current = startUrl;
    let redirects = 0;
    const go = (url) => {
      if (redirects > 5) {
        reject(new Error("Too many redirects."));
        return;
      }
      let u;
      try {
        u = new URL(url);
      } catch {
        reject(new Error("Bad download URL."));
        return;
      }
      if (u.protocol !== "https:") {
        reject(new Error("Refusing non-https download."));
        return;
      }
      // Initial URL is hardcoded; redirects only to the allowlist.
      if (redirects === 0) {
        if (url !== OLLAMA_INSTALL_URLS.win32 && url !== OLLAMA_INSTALL_URLS.darwin) {
          reject(new Error("Unexpected download URL."));
          return;
        }
      } else if (!OLLAMA_REDIRECT_HOSTS.has(u.hostname)) {
        reject(new Error(`Refusing redirect to ${u.hostname}.`));
        return;
      }
      const req = https.get(
        url,
        { headers: { "User-Agent": "Rocky-Ollama-Install" } },
        (res) => {
          const status = res.statusCode ?? 0;
          if (status >= 300 && status < 400 && res.headers.location) {
            redirects += 1;
            res.resume();
            go(new URL(res.headers.location, url).toString());
            return;
          }
          if (status !== 200) {
            reject(new Error(`Download failed (${status}).`));
            return;
          }
          const total = Number(res.headers["content-length"] ?? 0);
          let got = 0;
          const out = fs.createWriteStream(target);
          res.on("data", (chunk) => {
            got += chunk.length;
            // 300MB cap — installers are ~100MB; refuse anything absurd.
            if (got > 300 * 1024 * 1024) {
              req.destroy(new Error("Installer too large."));
              return;
            }
            try {
              onProgress({ got, total, percent: total ? Math.min(99, Math.round((got / total) * 100)) : null });
            } catch {}
          });
          res.pipe(out);
          out.on("finish", () => resolve(target));
          out.on("error", reject);
          res.on("error", reject);
        },
      );
      req.on("error", reject);
    };
    go(current);
  });
}

function registerShell() {
  ipcMain.handle("shell:openExternal", (_event, url) => {
    const s = String(url ?? "");
    // Allowlist: Ollama downloads only (no other hosts).
    if (s === "https://ollama.com/download" || isAllowedOllamaUrl(s)) {
      void shell.openExternal(s);
      return true;
    }
    return false;
  });
  // Renderer may only pass the platform; MAIN picks the hardcoded official URL,
  // streams it to Downloads with progress events, then launches it.
  ipcMain.handle("ollama:installOfficial", async (event, platform) => {
    const plat = String(platform ?? "");
    const url = plat.includes("win") ? OLLAMA_INSTALL_URLS.win32 : plat.includes("darwin") ? OLLAMA_INSTALL_URLS.darwin : null;
    if (!url) throw new Error("Unsupported platform for automatic install — use the download page.");
    const name = plat.includes("win") ? OLLAMA_INSTALL_NAMES.win32 : OLLAMA_INSTALL_NAMES.darwin;
    const target = path.join(app.getPath("downloads"), name);
    const sender = event.sender;
    const emit = (p) => {
      try {
        if (!sender.isDestroyed()) sender.send("ollama:install-progress", p);
      } catch {}
    };
    await downloadToFile(url, target, emit);
    try {
      if (!sender.isDestroyed()) sender.send("ollama:install-progress", { got: 1, total: 1, percent: 100 });
    } catch {}
    const opened = await shell.openPath(target);
    if (opened) throw new Error(opened);
    return target;
  });
}

const AUTO_CHECK_MS = 6 * 60 * 60 * 1000;
let autoTimer = null;

function registerUpdates() {
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  // Rocky's Windows builds aren't code-signed: with no publisherName in
  // app-update.yml electron-updater skips the signature check and relies on
  // the sha512 in latest.yml. Full downloads only (no differential patching).
  autoUpdater.disableDifferentialDownload = true;

  const broadcast = (state, extra) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send("update:state", { state, ...extra });
    }
  };

  autoUpdater.on("checking-for-update", () => broadcast("checking"));
  autoUpdater.on("update-available", (info) => broadcast("available", { version: info.version }));
  autoUpdater.on("update-not-available", () => broadcast("current"));
  autoUpdater.on("download-progress", (p) => broadcast("downloading", { percent: Math.round(p.percent) }));
  autoUpdater.on("update-downloaded", (info) => broadcast("ready", { version: info.version }));
  // electron-updater's errors carry the whole HTTP response — headers, and on
  // a GitHub 404 the Set-Cookie line too. That is useful in a log and terrible
  // in a 300px card, so the detail goes to the console and the card gets one
  // readable sentence.
  autoUpdater.on("error", (err) => broadcast("error", { message: explain(err) }));

  ipcMain.handle("update:version", () => app.getVersion());

  ipcMain.handle("update:check", async () => {
    // An unpackaged run has no app-update.yml and would throw; say so plainly.
    if (!app.isPackaged) return { state: "dev" };
    try {
      await autoUpdater.checkForUpdates();
      return { state: "checking" };
    } catch (err) {
      return { state: "error", message: explain(err) };
    }
  });

  ipcMain.handle("update:download", async () => {
    if (!app.isPackaged) return { state: "dev" };
    try {
      await autoUpdater.downloadUpdate();
      return { state: "downloading" };
    } catch (err) {
      return { state: "error", message: explain(err) };
    }
  });

  // "Check automatically on start and every 6 hours, download in the
  // background, ask before restarting" (profile extra, default on). The
  // renderer turns it on or off; restarting stays the user's press.
  ipcMain.handle("update:auto", async (_event, on) => {
    if (autoTimer) clearInterval(autoTimer);
    autoTimer = null;
    autoUpdater.autoDownload = on === true;
    if (on !== true || !app.isPackaged) return { auto: on === true };
    const check = () => autoUpdater.checkForUpdates().catch((err) => broadcast("error", { message: explain(err) }));
    void check();
    autoTimer = setInterval(check, AUTO_CHECK_MS);
    return { auto: true };
  });

  ipcMain.handle("update:install", () => {
    try {
      autoUpdater.quitAndInstall();
      return { state: "installing" };
    } catch (err) {
      return { state: "error", message: explain(err) };
    }
  });
}

// One Rocky at a time: a second copy would run a second booking agent and
// answer the phone's relay requests twice. A second launch focuses the first.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
}

/**
 * Staying reachable for the phone. While a phone is paired (the renderer says
 * so) and the app is open, Windows / macOS must not suspend the app; released
 * when the phone is unpaired and on quit. After sleep the renderer is told to
 * send a heartbeat right away.
 */
let keepAwakeId = null;
function setKeepAwake(on) {
  if (on && keepAwakeId == null) keepAwakeId = powerSaveBlocker.start("prevent-app-suspension");
  if (!on && keepAwakeId != null) {
    if (powerSaveBlocker.isStarted(keepAwakeId)) powerSaveBlocker.stop(keepAwakeId);
    keepAwakeId = null;
  }
  return keepAwakeId != null;
}
function registerPower() {
  ipcMain.handle("power:keepAwake", (_event, on) => setKeepAwake(on === true));
  const wake = () => {
    for (const w of BrowserWindow.getAllWindows()) w.webContents.send("power:resume");
  };
  powerMonitor.on("resume", wake);
  powerMonitor.on("unlock-screen", wake);
  app.on("will-quit", () => setKeepAwake(false));
}

app.whenReady().then(async () => {
  registerAppProtocol();
  registerPower();
  registerSecretHandlers();
  registerBrowserHandlers();
  require("./memoryMain.cjs").registerMemory();
  registerShell();
  registerUpdates();
  const session = require("electron").session.defaultSession;
  configurePermissions(session);
  applyCsp(session);

  // Surfaces the macOS mic prompt once, up front, instead of mid-conversation.
  if (process.platform === "darwin") {
    try {
      await systemPreferences.askForMediaAccess("microphone");
    } catch {
      // User can still grant it later in System Settings.
    }
  }

  // Unpackaged runs show the Electron logo in the Dock unless we set it.
  if (process.platform === "darwin" && !app.isPackaged && app.dock) {
    const devIcon = path.join(__dirname, "..", "build", "icon.png");
    if (fs.existsSync(devIcon)) app.dock.setIcon(devIcon);
  }

  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
