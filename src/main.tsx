import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import AuthGate from "./components/AuthGate";
import ErrorBoundary from "./components/ErrorBoundary";
import RemotePage from "./pages/RemotePage";
import { shouldShowMobileUi } from "./lib/isMobile";
import { installNativeShell } from "./lib/nativeShell";
import "./index.css";

// Phone route (render.yaml rewrites /remote to index.html). Phones also get
// the mobile UI on the root URL so scanning the QR — or typing the address —
// never lands them in the desktop app.
const showMobileUi =
  typeof window !== "undefined" && shouldShowMobileUi(window.location.pathname);

// Android app only: deep links, resume, bar colours, updates.
installNativeShell();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary>
      <AuthGate>{showMobileUi ? <RemotePage /> : <App />}</AuthGate>
    </ErrorBoundary>
  </StrictMode>,
);
