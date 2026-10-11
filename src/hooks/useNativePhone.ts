import { useEffect, useRef, useState } from "react";
import { isNativeApp } from "../lib/native";
import { backAction, type PhoneTab } from "../lib/phoneTabs";

/**
 * Phone shell behaviour that needs the tab state:
 *   - Android Back: close settings, then Chat -> Calendar, then leave the app;
 *   - keep the screen on only while a booking run is going (Android app);
 *   - online/offline for the banner (everywhere).
 */
export function useNativePhone(p: { tab: PhoneTab; setTab: (t: PhoneTab) => void; settingsOpen: boolean; closeSettings: () => void; agentRunning: boolean }): { online: boolean } {
  const ref = useRef(p);
  ref.current = p;

  useEffect(() => {
    if (!isNativeApp()) return;
    let remove: (() => void) | null = null;
    void import("@capacitor/app").then(({ App }) =>
      App.addListener("backButton", () => {
        const s = ref.current;
        const action = backAction({ tab: s.tab, settingsOpen: s.settingsOpen });
        if (action === "close-settings") s.closeSettings();
        else if (action === "to-calendar") s.setTab("calendar");
        else void App.minimizeApp();
      }).then((h) => {
        remove = () => void h.remove();
      }),
    );
    return () => remove?.();
  }, []);

  useEffect(() => {
    if (!isNativeApp()) return;
    void import("@capacitor-community/keep-awake").then(({ KeepAwake }) => (p.agentRunning ? KeepAwake.keepAwake() : KeepAwake.allowSleep())).catch(() => {});
  }, [p.agentRunning]);

  const [online, setOnline] = useState(() => (typeof navigator === "undefined" ? true : navigator.onLine));
  useEffect(() => {
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener("online", up);
    window.addEventListener("offline", down);
    return () => {
      window.removeEventListener("online", up);
      window.removeEventListener("offline", down);
    };
  }, []);
  return { online };
}
