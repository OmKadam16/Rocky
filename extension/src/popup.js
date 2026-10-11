// Rocky Memory popup.
const $ = (id) => document.getElementById(id);
const ask = (msg) => chrome.runtime.sendMessage(msg);
const ALL_SITES = { origins: ["https://*/*", "http://*/*"] };

const REASONS = {
  not_connected: "Connect to Rocky first.",
  not_paired: "Token doesn't match — paste the one from Rocky's Memory page.",
  queued: "Rocky isn't running — saved for later.",
  excluded: "This site is excluded, so nothing was saved.",
  password: "Pages with a password field are never saved.",
  payment: "Payment pages are never saved.",
  incognito: "Incognito windows are never saved.",
  blocked: "Chrome doesn't let extensions read this page.",
  empty: "Nothing readable on this page.",
  off: "Memory is off in Rocky. Turn it on in the Memory page.",
  paused: "Memory is paused in Rocky.",
};

function say(text, warn = false) {
  $("msg").textContent = text || "";
  $("msg").className = warn ? "msg warn" : "msg";
}

async function render() {
  const s = await ask({ type: "status" });
  $("dot").className = s.connected ? "dot on" : "dot";
  $("connect").hidden = s.hasToken && !s.error?.startsWith("Token");
  $("main").hidden = !s.hasToken;
  if (!s.hasToken) {
    $("connect").hidden = false;
    return;
  }
  $("port").value = s.port;
  const paused = s.paused || s.appPaused;
  $("state").textContent = paused ? "Paused" : s.appEnabled === false ? "Off in Rocky" : "On";
  $("pauseBtn").textContent = s.paused ? "Resume" : "Pause";
  $("count").textContent = s.connected ? `${s.count} saved on this computer${s.queued ? ` · ${s.queued} waiting` : ""}` : s.queued ? `${s.queued} waiting for Rocky` : "";
  $("auto").hidden = await chrome.permissions.contains(ALL_SITES);
  if (s.error) say(s.error, true);
}

$("connectBtn").addEventListener("click", async () => {
  const token = $("token").value.trim();
  if (!token) return say("Paste the token first.", true);
  const s = await ask({ type: "connect", token, port: Number($("port").value) || undefined });
  $("token").value = "";
  say(s.connected ? "Connected." : s.error || "Couldn't reach Rocky.", !s.connected);
  await render();
});

$("pauseBtn").addEventListener("click", async () => {
  const s = await ask({ type: "status" });
  await ask({ type: "set-paused", paused: !s.paused });
  say(s.paused ? "Saving again." : "Paused. Nothing new is saved until you resume.");
  await render();
});

$("saveBtn").addEventListener("click", async () => {
  say("Saving…");
  const r = await ask({ type: "save-now", screenshot: $("shot").checked });
  say(r.ok ? "Saved to Memory." : REASONS[r.reason] || "Not saved.", !r.ok);
  await render();
});

$("excludeBtn").addEventListener("click", async () => {
  const r = await ask({ type: "exclude-site" });
  say(r.ok ? `${r.host} won't be saved.` : "No site to exclude here.", !r.ok);
});

$("grantBtn").addEventListener("click", async () => {
  // Chrome shows its own prompt; nothing is read until the user agrees.
  const ok = await chrome.permissions.request(ALL_SITES);
  say(ok ? "Pages you visit will be saved automatically (except excluded sites)." : "Automatic saving stays off.", !ok);
  await render();
});

$("relink").addEventListener("click", () => {
  $("connect").hidden = false;
});

void render();
