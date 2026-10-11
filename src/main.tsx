import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import AuthGate from "./components/AuthGate";
import ErrorBoundary from "./components/ErrorBoundary";
import RemotePage from "./pages/RemotePage";
import { shouldShowMobileUi } from "./lib/isMobile";
import { installNativeShell } from "./lib/nativeShell";
import { isNativeApp } from "./lib/native";
import { isSupabaseConfigured } from "./lib/supabase";
import { startBoot } from "./lib/boot";
import "./index.css";

// Never a blank screen: a watchdog shows the real error if startup stalls.
const boot = startBoot(__APP_VERSION__);
boot.step(`start v${__APP_VERSION__} ${isNativeApp() ? "android" : "web"} ${location.origin}${location.pathname} cloud=${isSupabaseConfigured}`);

// Phone route (render.yaml rewrites /remote to index.html). Phones also get
// the mobile UI on the root URL so scanning the QR, or typing the address,
// never lands them in the desktop app.
const showMobileUi =
  typeof window !== "undefined" && shouldShowMobileUi(window.location.pathname);

try {
  // Android app only: deep links, resume, bar colours, updates.
  installNativeShell();
  boot.step("native shell");
} catch (e) {
  boot.error(e);
}

boot.step(`render ${showMobileUi ? "phone" : "desktop"} UI`);
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary>
      <AuthGate>{showMobileUi ? <RemotePage /> : <App />}</AuthGate>
    </ErrorBoundary>
  </StrictMode>,
);
