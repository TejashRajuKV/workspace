import { createRoot } from "react-dom/client";
import App from "@/App";
import ErrorBoundary from "@/components/ErrorBoundary";
import "@/styles/globals.css";

// Client entry point. The app is a single-page application: the Node server
// always answers `/` with the same shell and the views (auth → dashboard →
// workspace) are internal state, so there is no client-side router.
const container = document.getElementById("root");
if (!container) throw new Error("#root container is missing from index.html");

createRoot(container).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>
);

// Register the service worker (PWA / offline shell). Only in production-ish
// HTTPS/localhost contexts; failures are non-fatal.
if ("serviceWorker" in navigator && location.protocol !== "file:") {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  });
}