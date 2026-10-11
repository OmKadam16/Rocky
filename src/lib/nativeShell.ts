/**
 * The Android app's shell behaviour, installed once at start (main.tsx):
 *   - Supabase email links (confirm / reset) come back as a deep link and are
 *     exchanged for a session here;
 *   - coming back to the foreground re-validates the session, reconnects
 *     realtime and refreshes the calendar;
 *   - the status/navigation bar icons follow the app's light/dark theme;
 *   - over-the-air updates (appUpdateNative.ts).
 */
import { SystemBars, SystemBarsStyle } from "@capacitor/core";
import { App } from "@capacitor/app";
import { authCodeFromUrl, isNativeApp } from "./native";
import { isSupabaseConfigured, supabase } from "./supabase";
import { startRealtime } from "./supaDb";

let installed = false;

export function installNativeShell(): void {
  if (installed || !isNativeApp()) return;
  installed = true;

  // An app, not a web page: no pinch zoom, no rubber-band overscroll, content
  // under the system bars (edge-to-edge; insets via --safe-area-inset-*).
  document.documentElement.classList.add("native-app");
  document.querySelector('meta[name="viewport"]')?.setAttribute("content", "width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover");

  void App.addListener("appUrlOpen", ({ url }) => {
    const code = authCodeFromUrl(url);
    if (code && isSupabaseConfigured) void supabase().auth.exchangeCodeForSession(code).catch(() => {});
  });

  void App.addListener("appStateChange", ({ isActive }) => {
    if (!isSupabaseConfigured) return;
    const auth = supabase().auth;
    if (!isActive) {
      void auth.stopAutoRefresh();
      return;
    }
    void auth.startAutoRefresh();
    void auth.getSession().then(({ data }) => {
      if (!data.session) return;
      startRealtime(); // restarts cleanly (it stops the old channel first)
      window.dispatchEvent(new CustomEvent("vc-data-change", { detail: { table: "*" } }));
    });
  });

  // Bar icons: dark icons on the light canvas, light icons on the dark one.
  const syncBars = () => {
    const dark = document.documentElement.getAttribute("data-theme") === "dark";
    void SystemBars.setStyle({ style: dark ? SystemBarsStyle.Dark : SystemBarsStyle.Light }).catch(() => {});
  };
  syncBars();
  new MutationObserver(syncBars).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

  void import("./appUpdateNative").then((m) => m.startNativeUpdates()).catch(() => {});
}
