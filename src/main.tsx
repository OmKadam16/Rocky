import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import AuthGate from "./components/AuthGate";
import ErrorBoundary from "./components/ErrorBoundary";
import RemotePage from "./pages/RemotePage";
import "./index.css";

// Phone route (render.yaml rewrites /remote to index.html).
const isRemoteRoute = typeof window !== "undefined" && window.location.pathname === "/remote";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary>
      <AuthGate>{isRemoteRoute ? <RemotePage /> : <App />}</AuthGate>
    </ErrorBoundary>
  </StrictMode>,
);
